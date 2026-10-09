import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { win32 } from "node:path";
import type { Writable } from "node:stream";

export type ClipboardTransactionStatus = "restored" | "changed";

export type ClipboardTransaction = {
  finish(): Promise<ClipboardTransactionStatus>;
};

export type ClipboardContent = {
  text: string;
  html?: string;
};

type ClipboardInput = string | ClipboardContent;

type ClipboardTransactionOptions = {
  beginTransaction?: (content: ClipboardInput) => Promise<ClipboardTransaction>;
};

type ClipboardHostMessage = {
  state: "ready" | "restored" | "changed" | "error";
  message?: string;
};

export class ClipboardRestoreError extends Error {
  readonly code = "EGO_CLIPBOARD_RESTORE_FAILED";
  readonly pasteCompleted = true;

  constructor(cause: unknown) {
    super(
      "The paste completed, but ego-browser could not restore the clipboard. Do not retry the paste.",
      { cause },
    );
    this.name = "ClipboardRestoreError";
  }
}

let transactionQueue: Promise<void> = Promise.resolve();

/**
 * Run one action while the system clipboard temporarily contains `text`.
 * Transactions are serialized within the process because the clipboard is a
 * single user resource shared by every Page.
 */
export async function withTemporaryClipboardText<T>(
  text: ClipboardInput,
  action: () => Promise<T>,
  options: ClipboardTransactionOptions = {},
): Promise<T> {
  const content = validateClipboardInput(text);
  if (typeof action !== "function") {
    throw new TypeError("clipboard action must be a function");
  }

  let releaseQueue!: () => void;
  const previous = transactionQueue;
  transactionQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  await previous;

  try {
    const beginTransaction =
      options.beginTransaction ?? beginNativeClipboardTransaction;
    const transaction = await beginTransaction(content);
    let value!: T;
    let actionError: unknown;
    try {
      value = await action();
    } catch (error) {
      actionError = error;
    }

    let restoreError: unknown;
    try {
      await transaction.finish();
    } catch (error) {
      restoreError = error;
    }

    if (actionError !== undefined) {
      if (restoreError !== undefined) {
        throw new AggregateError(
          [actionError, restoreError],
          "The paste action failed and ego-browser could not restore the clipboard.",
        );
      }
      throw actionError;
    }
    if (restoreError !== undefined) {
      throw new ClipboardRestoreError(restoreError);
    }
    return value;
  } finally {
    releaseQueue();
  }
}

/** Temporarily publish multiple representations of the same clipboard value. */
export async function withTemporaryClipboardContent<T>(
  content: ClipboardContent,
  action: () => Promise<T>,
  options: ClipboardTransactionOptions = {},
): Promise<T> {
  return withTemporaryClipboardText(content, action, options);
}

function beginNativeClipboardTransaction(
  input: ClipboardInput,
  platform: string = process.platform,
): Promise<ClipboardTransaction> {
  if (platform === "darwin") return beginDarwinClipboardTransaction(input);
  if (platform === "win32") return beginWin32ClipboardTransaction(input);
  if (platform === "linux") return beginLinuxClipboardTransaction(input);
  return Promise.reject(
    new Error(
      "page.keyboard.paste requires macOS, Windows, or Linux clipboard support; use page.keyboard.insertText() for plain text",
    ),
  );
}

type ClipboardHost = {
  platformName: string;
  sendContent(stdin: Writable): void;
  signalRestore(): void;
};

/**
 * Keep the original NSPasteboard items inside a short-lived JXA process. The
 * data never crosses stdout or enters the Node heap, and every readable format
 * is restored unless another process changes the clipboard first.
 */
function beginDarwinClipboardTransaction(
  input: ClipboardInput,
): Promise<ClipboardTransaction> {
  const child = spawn(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", DARWIN_CLIPBOARD_HOST],
    { stdio: ["pipe", "pipe", "pipe", "pipe"] },
  );
  return startClipboardHost(child, {
    platformName: "macOS",
    sendContent(stdin) {
      stdin.end(JSON.stringify(input), "utf8");
    },
    signalRestore() {
      const signalPipe = child.stdio[3] as Writable | null;
      if (!signalPipe) {
        throw new Error("clipboard restore pipe is unavailable");
      }
      signalPipe.end("1");
    },
  });
}

type SpawnClipboardHost = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Keep the original clipboard formats inside a short-lived Windows PowerShell
 * process, mirroring the macOS host. Windows PowerShell 5.1 ships with every
 * supported Windows release, so no extra dependency is needed.
 */
function beginWin32ClipboardTransaction(
  input: ClipboardInput,
  spawnHost: SpawnClipboardHost = spawn,
): Promise<ClipboardTransaction> {
  const content = typeof input === "string" ? { text: input } : input;
  const child = spawnHost(
    windowsPowerShellPath(),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      // Without this, PowerShell drains stdin to EOF before running the
      // command, and stdin must stay open to carry the restore signal.
      "-InputFormat",
      "None",
      "-EncodedCommand",
      WIN32_CLIPBOARD_HOST_COMMAND,
    ],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  return startClipboardHost(child, {
    platformName: "Windows",
    sendContent(stdin) {
      // Base64 lines keep the payload independent of console code pages.
      const text = Buffer.from(content.text, "utf8").toString("base64");
      const html =
        content.html === undefined
          ? ""
          : windowsHtmlClipboardFormat(content.html).toString("base64");
      stdin.write(`${text}\n${html}\n`);
    },
    signalRestore() {
      child.stdin?.end("restore\n");
    },
  });
}

function windowsPowerShellPath(): string {
  return win32.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * Keep the original clipboard text (and HTML when available) inside a
 * short-lived Python host. Prefers xclip on X11, then wl-clipboard on
 * Wayland. Temporary HTML uses GTK's multi-target clipboard when needed so
 * plain text stays pasteable alongside raw text/html (not Windows CF_HTML).
 */
function beginLinuxClipboardTransaction(
  input: ClipboardInput,
  spawnHost: SpawnClipboardHost = spawn,
): Promise<ClipboardTransaction> {
  const content = typeof input === "string" ? { text: input } : input;
  const child = spawnHost(
    process.env.EGO_BROWSER_PYTHON ?? "python3",
    ["-c", LINUX_CLIPBOARD_HOST_COMMAND],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return startClipboardHost(child, {
    platformName: "Linux",
    sendContent(stdin) {
      const text = Buffer.from(content.text, "utf8").toString("base64");
      const html =
        content.html === undefined
          ? ""
          : Buffer.from(content.html, "utf8").toString("base64");
      stdin.write(`${text}\n${html}\n`);
    },
    signalRestore() {
      child.stdin?.end("restore\n");
    },
  });
}

/**
 * Wrap an HTML fragment in the Windows `HTML Format` clipboard envelope. Its
 * header offsets count UTF-8 bytes from the start of the payload.
 */
function windowsHtmlClipboardFormat(html: string): Buffer {
  const prefix = "<html><body>\r\n<!--StartFragment-->";
  const suffix = "<!--EndFragment-->\r\n</body></html>";
  const header = (offsets: number[]) => {
    const [startHtml, endHtml, startFragment, endFragment] = offsets.map(
      (offset) => String(offset).padStart(10, "0"),
    );
    return (
      "Version:0.9\r\n" +
      `StartHTML:${startHtml}\r\n` +
      `EndHTML:${endHtml}\r\n` +
      `StartFragment:${startFragment}\r\n` +
      `EndFragment:${endFragment}\r\n`
    );
  };
  const startHtml = Buffer.byteLength(header([0, 0, 0, 0]));
  const startFragment = startHtml + Buffer.byteLength(prefix);
  const endFragment = startFragment + Buffer.byteLength(html);
  const endHtml = endFragment + Buffer.byteLength(suffix);
  return Buffer.from(
    header([startHtml, endHtml, startFragment, endFragment]) +
      prefix +
      html +
      suffix,
    "utf8",
  );
}

async function startClipboardHost(
  child: ChildProcess,
  host: ClipboardHost,
): Promise<ClipboardTransaction> {
  const { stdin, stdout, stderr: stderrStream } = child;
  if (!stdin || !stdout || !stderrStream) {
    throw new Error("clipboard host pipes are unavailable");
  }
  const messages = clipboardMessages(stdout);
  let stderr = "";
  stderrStream.setEncoding("utf8");
  stderrStream.on("data", (chunk) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // A host that exits early reports through its exit status; the broken pipe
  // must not surface as an unhandled stream error.
  stdin.on("error", () => {});

  host.sendContent(stdin);
  const first = await nextHostMessage(messages, exit, () => stderr);
  if (first.state !== "ready") {
    throw new Error(
      first.message || `could not prepare the ${host.platformName} clipboard`,
    );
  }

  let finished = false;
  return {
    async finish() {
      if (finished) throw new Error("clipboard transaction already finished");
      finished = true;
      host.signalRestore();
      const result = await nextHostMessage(messages, exit, () => stderr);
      const completion = await exit;
      if (result.state === "error") {
        throw new Error(
          result.message ||
            `could not restore the ${host.platformName} clipboard`,
        );
      }
      if (completion.code !== 0) {
        throw clipboardHostExitError(completion, stderr);
      }
      if (result.state === "restored" || result.state === "changed") {
        return result.state;
      }
      throw new Error(`unexpected clipboard host response: ${result.state}`);
    },
  };
}

function describeClipboardArgument(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function validateClipboardInput(input: ClipboardInput): ClipboardInput {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(
      `page.keyboard.paste requires a string or { text, html? }, received ${describeClipboardArgument(input)}`,
    );
  }
  const keys = Object.keys(input);
  const unknown = keys.find((key) => key !== "text" && key !== "html");
  if (unknown) {
    throw new TypeError(
      `page.keyboard.paste received unknown content field: ${unknown}`,
    );
  }
  if (typeof input.text !== "string") {
    throw new TypeError("page.keyboard.paste content.text must be a string");
  }
  if (input.html !== undefined && typeof input.html !== "string") {
    throw new TypeError("page.keyboard.paste content.html must be a string");
  }
  return input.html === undefined
    ? { text: input.text }
    : { text: input.text, html: input.html };
}

function clipboardMessages(stream: NodeJS.ReadableStream) {
  const queued: ClipboardHostMessage[] = [];
  const waiters: Array<{
    resolve: (message: ClipboardHostMessage) => void;
    reject: (error: unknown) => void;
  }> = [];
  let buffer = "";
  let ended = false;
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: ClipboardHostMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectWaiter(new Error(`invalid clipboard host response: ${line}`));
        continue;
      }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else queued.push(message);
    }
  });
  stream.on("error", rejectWaiter);
  // A host that fails to spawn destroys its pipes without emitting `end`.
  for (const event of ["end", "close"]) {
    stream.on(event, () => {
      if (ended) return;
      ended = true;
      rejectWaiter(new Error("clipboard host closed without a response"));
    });
  }

  function rejectWaiter(error: unknown) {
    const waiter = waiters.shift();
    if (waiter) waiter.reject(error);
  }

  return {
    next(): Promise<ClipboardHostMessage> {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      if (ended) {
        return Promise.reject(
          new Error("clipboard host closed without a response"),
        );
      }
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
  };
}

async function nextHostMessage(
  messages: ReturnType<typeof clipboardMessages>,
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  stderr: () => string,
): Promise<ClipboardHostMessage> {
  try {
    // Child `exit` may be emitted before its stdout pipe drains. Read the
    // protocol message first so a successful restore cannot race with exit.
    return await messages.next();
  } catch (error) {
    const completion = await exit;
    if (completion.code !== 0 || completion.signal) {
      throw clipboardHostExitError(completion, stderr());
    }
    throw error;
  }
}

function clipboardHostExitError(
  completion: { code: number | null; signal: NodeJS.Signals | null },
  stderr: string,
) {
  const detail = stderr.trim();
  return new Error(
    `clipboard host exited ${
      completion.signal
        ? `on ${completion.signal}`
        : `with code ${completion.code}`
    }${detail ? `: ${detail}` : ""}`,
  );
}

const DARWIN_CLIPBOARD_HOST = String.raw`
ObjC.import("AppKit");
ObjC.import("Foundation");

const pasteboard = $.NSPasteboard.generalPasteboard;
const transactionLock = $.NSDistributedLock.alloc.initWithPath(
  $(ObjC.unwrap($.NSTemporaryDirectory()) + "ego-browser-clipboard.lock")
);

function acquireTransactionLock() {
  const deadline = Date.now() + 5000;
  while (!transactionLock.tryLock) {
    const lockDate = transactionLock.lockDate;
    const lockAge = lockDate
      ? Date.now() - Number(lockDate.timeIntervalSince1970) * 1000
      : 0;
    if (lockAge > 30000) {
      transactionLock.breakLock;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("another ego-browser process is using the clipboard");
    }
    $.NSThread.sleepForTimeInterval(0.02);
  }
}

function emit(message) {
  const line = $(JSON.stringify(message) + "\n").dataUsingEncoding($.NSUTF8StringEncoding);
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(line);
}

function snapshotPasteboard() {
  const snapshot = [];
  const sourceItems = pasteboard.pasteboardItems;
  for (let itemIndex = 0; itemIndex < Number(sourceItems.count); itemIndex += 1) {
    const sourceItem = sourceItems.objectAtIndex(itemIndex);
    const values = [];
    const types = sourceItem.types;
    for (let typeIndex = 0; typeIndex < Number(types.count); typeIndex += 1) {
      const type = types.objectAtIndex(typeIndex);
      const data = sourceItem.dataForType(type);
      if (data) values.push({ type, data });
    }
    snapshot.push(values);
  }
  return snapshot;
}

function restorePasteboard(snapshot) {
  pasteboard.clearContents;
  if (snapshot.length === 0) return;
  const restoredItems = [];
  for (const values of snapshot) {
    const item = $.NSPasteboardItem.alloc.init;
    for (const value of values) item.setDataForType(value.data, value.type);
    restoredItems.push(item);
  }
  if (!pasteboard.writeObjects($(restoredItems))) {
    throw new Error("NSPasteboard rejected the saved clipboard items");
  }
}

const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const serialized = ObjC.unwrap(
  $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)
);
const parsed = JSON.parse(serialized);
const content = typeof parsed === "string" ? { text: parsed } : parsed;
acquireTransactionLock();
const saved = snapshotPasteboard();

try {
  pasteboard.clearContents;
  if (!pasteboard.setStringForType($(content.text), $.NSPasteboardTypeString)) {
    throw new Error("NSPasteboard rejected the temporary text");
  }
  if (
    content.html !== undefined &&
    !pasteboard.setStringForType($(content.html), $.NSPasteboardTypeHTML)
  ) {
    throw new Error("NSPasteboard rejected the temporary HTML");
  }
} catch (error) {
  try { restorePasteboard(saved); } catch (_) {}
  emit({ state: "error", message: String(error.message || error) });
  transactionLock.unlock;
  throw error;
}

const temporaryChangeCount = Number(pasteboard.changeCount);
emit({ state: "ready" });

const restoreSignal = $.NSFileHandle.alloc.initWithFileDescriptorCloseOnDealloc(3, false);
restoreSignal.readDataOfLength(1);

try {
  try {
    if (Number(pasteboard.changeCount) !== temporaryChangeCount) {
      emit({ state: "changed" });
    } else {
      restorePasteboard(saved);
      emit({ state: "restored" });
    }
  } catch (error) {
    emit({ state: "error", message: String(error.message || error) });
    throw error;
  }
} finally {
  transactionLock.unlock;
}
`;

// The host reads two base64 lines (UTF-8 text, then an optional `HTML Format`
// payload), reports `ready`, and restores after the next stdin line.
const WIN32_CLIPBOARD_HOST = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms

$utf8 = [System.Text.UTF8Encoding]::new($false)
$stdin = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
$stdout = [System.IO.StreamWriter]::new([Console]::OpenStandardOutput(), $utf8)
$stdout.AutoFlush = $true

function Send-HostMessage($message) {
  $stdout.WriteLine((ConvertTo-Json -InputObject $message -Compress))
}

# GetClipboardSequenceNumber plays the role of NSPasteboard.changeCount.
# Reflection.Emit binds it without Add-Type, which would spawn the C# compiler.
$nativeAssembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
  [System.Reflection.AssemblyName]::new('EgoBrowserClipboard'),
  [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$nativeBuilder = $nativeAssembly.DefineDynamicModule('EgoBrowserClipboard').DefineType(
  'EgoBrowserClipboardNative', 'Public, Class')
$sequenceMethod = $nativeBuilder.DefinePInvokeMethod(
  'GetClipboardSequenceNumber',
  'user32.dll',
  [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
  [System.Reflection.CallingConventions]::Standard,
  [UInt32],
  [Type[]]@(),
  [System.Runtime.InteropServices.CallingConvention]::Winapi,
  [System.Runtime.InteropServices.CharSet]::Auto)
$sequenceMethod.SetImplementationFlags([System.Reflection.MethodImplAttributes]::PreserveSig)
$native = $nativeBuilder.CreateType()

# Returns $null for an empty clipboard. Formats that cannot be read are
# skipped, so the restore is best effort for exotic or delayed-render data.
function Save-Clipboard {
  $source = [System.Windows.Forms.Clipboard]::GetDataObject()
  if ($null -eq $source) { return $null }
  $saved = [System.Windows.Forms.DataObject]::new()
  $savedAny = $false
  foreach ($format in $source.GetFormats($false)) {
    try { $data = $source.GetData($format, $false) } catch { continue }
    if ($null -ne $data) {
      $saved.SetData($format, $false, $data)
      $savedAny = $true
    }
  }
  if ($savedAny) { return $saved }
  return $null
}

function Restore-Clipboard($saved) {
  if ($null -ne $saved) {
    [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true, 10, 100)
    return
  }
  for ($attempt = 1; ; $attempt += 1) {
    try {
      [System.Windows.Forms.Clipboard]::Clear()
      return
    } catch {
      if ($attempt -ge 10) { throw }
      Start-Sleep -Milliseconds 100
    }
  }
}

$mutex = [System.Threading.Mutex]::new($false, 'Local\ego-browser-clipboard')
$locked = $false
$exitCode = 0
try {
  $text = $utf8.GetString([Convert]::FromBase64String($stdin.ReadLine()))
  $htmlLine = $stdin.ReadLine()

  try {
    $locked = $mutex.WaitOne(5000)
  } catch [System.Threading.AbandonedMutexException] {
    $locked = $true
  }
  if (-not $locked) { throw 'another ego-browser process is using the clipboard' }

  $saved = Save-Clipboard
  try {
    $temporary = [System.Windows.Forms.DataObject]::new()
    $temporary.SetData([System.Windows.Forms.DataFormats]::UnicodeText, $false, $text)
    if ($htmlLine) {
      $html = [System.IO.MemoryStream]::new([Convert]::FromBase64String($htmlLine))
      $temporary.SetData([System.Windows.Forms.DataFormats]::Html, $false, $html)
    }
    # copy=$true flushes every format now, so the paste never depends on this
    # process pumping delayed-render messages while it waits on stdin.
    [System.Windows.Forms.Clipboard]::SetDataObject($temporary, $true, 10, 100)
  } catch {
    try { Restore-Clipboard $saved } catch {}
    throw
  }

  $temporarySequence = $native::GetClipboardSequenceNumber()
  Send-HostMessage @{ state = 'ready' }
  [void]$stdin.ReadLine()

  if ($native::GetClipboardSequenceNumber() -ne $temporarySequence) {
    Send-HostMessage @{ state = 'changed' }
  } else {
    Restore-Clipboard $saved
    Send-HostMessage @{ state = 'restored' }
  }
} catch {
  Send-HostMessage @{ state = 'error'; message = [string]$_.Exception.Message }
  $exitCode = 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
exit $exitCode
`;

const WIN32_CLIPBOARD_HOST_COMMAND = Buffer.from(
  WIN32_CLIPBOARD_HOST,
  "utf16le",
).toString("base64");

// The host reads two base64 lines (UTF-8 text, then optional raw HTML),
// reports `ready`, and restores after the next stdin line. X11 uses xclip
// (and GTK for text+HTML); Wayland uses wl-copy/wl-paste.
const LINUX_CLIPBOARD_HOST = String.raw`
import base64
import ctypes
import ctypes.util
import fcntl
import json
import os
import select
import shutil
import subprocess
import sys
import time

LOCK_PATH = "/tmp/ego-browser-clipboard.lock"


def emit(state, message=None):
    payload = {"state": state}
    if message is not None:
        payload["message"] = message
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def fail(message):
    emit("error", message)
    sys.exit(1)


def read_b64_line():
    line = sys.stdin.readline()
    if line == "":
        fail("clipboard host closed before content arrived")
    line = line.strip()
    if not line:
        return b""
    return base64.b64decode(line)


def acquire_lock(lock_fd):
    deadline = time.time() + 5
    while True:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.time() >= deadline:
                fail("another ego-browser process is using the clipboard")
            time.sleep(0.02)


def choose_backend():
    display = os.environ.get("DISPLAY")
    wayland = os.environ.get("WAYLAND_DISPLAY")
    if display and shutil.which("xclip"):
        return "x11"
    if wayland and shutil.which("wl-copy") and shutil.which("wl-paste"):
        return "wayland"
    if not display and not wayland:
        fail("page.keyboard.paste on Linux requires DISPLAY (xclip) or WAYLAND_DISPLAY (wl-clipboard)")
    if display:
        fail("page.keyboard.paste on Linux requires xclip when DISPLAY is set")
    fail("page.keyboard.paste on Linux requires wl-copy and wl-paste when WAYLAND_DISPLAY is set")


def xclip_get(target):
    # An unowned CLIPBOARD selection makes xclip block forever; bound it.
    try:
        result = subprocess.run(
            ["xclip", "-selection", "clipboard", "-o", "-t", target],
            capture_output=True,
            timeout=1,
        )
    except subprocess.TimeoutExpired:
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def xclip_targets():
    raw = xclip_get("TARGETS")
    if raw is None:
        return set()
    return {
        line.decode("utf-8", "replace").strip()
        for line in raw.splitlines()
        if line.strip()
    }


def xclip_set(target, data):
    # xclip often keeps running as the selection owner after reading stdin.
    proc = subprocess.Popen(
        ["xclip", "-selection", "clipboard", "-t", target],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    proc.stdin.write(data)
    proc.stdin.close()
    try:
        proc.wait(timeout=1)
    except subprocess.TimeoutExpired:
        return
    if proc.returncode != 0:
        err = proc.stderr.read().decode("utf-8", "replace").strip()
        raise RuntimeError(err or "xclip failed to set the clipboard")


def xclip_clear():
    xclip_set("UTF8_STRING", b"")


def snapshot_x11():
    targets = xclip_targets()
    text = None
    html = None
    if "UTF8_STRING" in targets or "text/plain;charset=utf-8" in targets or "TEXT" in targets:
        text = xclip_get("UTF8_STRING")
        if text is None:
            text = xclip_get("text/plain;charset=utf-8")
        if text is None:
            text = xclip_get("TEXT")
    if "text/html" in targets:
        html = xclip_get("text/html")
    return {"text": text, "html": html}


def restore_x11(saved):
    if saved["text"] is None and saved["html"] is None:
        xclip_clear()
        return
    if saved["text"] is not None:
        xclip_set("UTF8_STRING", saved["text"])
    if saved["html"] is not None:
        # Best effort: xclip owns one target; prefer keeping plain text pasteable.
        if saved["text"] is None:
            xclip_set("text/html", saved["html"])


def current_x11_text():
    return xclip_get("UTF8_STRING") or xclip_get("text/plain;charset=utf-8") or xclip_get("TEXT")


def wl_get(mime):
    try:
        result = subprocess.run(
            ["wl-paste", "--no-newline", "-t", mime],
            capture_output=True,
            timeout=1,
        )
    except subprocess.TimeoutExpired:
        return None
    if result.returncode != 0:
        return None
    return result.stdout


def snapshot_wayland():
    text = wl_get("text/plain;charset=utf-8")
    if text is None:
        text = wl_get("text/plain")
    html = wl_get("text/html")
    return {"text": text, "html": html}


def wl_set(mime, data):
    subprocess.run(
        ["wl-copy", "--type", mime],
        input=data,
        check=True,
        capture_output=True,
        timeout=5,
    )


def wl_clear():
    subprocess.run(
        ["wl-copy", "--clear"], check=False, capture_output=True, timeout=5
    )


def restore_wayland(saved):
    if saved["text"] is None and saved["html"] is None:
        wl_clear()
        return
    if saved["text"] is not None:
        wl_set("text/plain;charset=utf-8", saved["text"])
    elif saved["html"] is not None:
        wl_set("text/html", saved["html"])


def current_wayland_text():
    return wl_get("text/plain;charset=utf-8") or wl_get("text/plain")


class GtkClipboard:
    TEXT_INFO = 1
    HTML_INFO = 2

    def __init__(self, text, html):
        self.text = text
        self.html = html
        self.lost = False
        self._load()
        self._set()

    def _load(self):
        gtk_name = ctypes.util.find_library("gtk-3")
        gdk_name = ctypes.util.find_library("gdk-3")
        glib_name = ctypes.util.find_library("glib-2.0")
        if not gtk_name or not gdk_name or not glib_name:
            raise RuntimeError("libgtk-3 is unavailable for multi-format clipboard")
        self.gtk = ctypes.CDLL(gtk_name)
        self.gdk = ctypes.CDLL(gdk_name)
        self.glib = ctypes.CDLL(glib_name)
        self.gtk.gtk_init(None, None)
        self.gdk.gdk_atom_intern.restype = ctypes.c_void_p
        self.gdk.gdk_atom_intern.argtypes = [ctypes.c_char_p, ctypes.c_int]
        clipboard_atom = self.gdk.gdk_atom_intern(b"CLIPBOARD", 0)
        self.gtk.gtk_clipboard_get.restype = ctypes.c_void_p
        self.gtk.gtk_clipboard_get.argtypes = [ctypes.c_void_p]
        self.clipboard = self.gtk.gtk_clipboard_get(clipboard_atom)

        class GtkTargetEntry(ctypes.Structure):
            _fields_ = [
                ("target", ctypes.c_char_p),
                ("flags", ctypes.c_uint),
                ("info", ctypes.c_uint),
            ]

        self.GtkTargetEntry = GtkTargetEntry
        GetFunc = ctypes.CFUNCTYPE(
            None, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p
        )
        ClearFunc = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)

        @GetFunc
        def on_get(clipboard, selection_data, info, user_data):
            if info == self.TEXT_INFO:
                self.gtk.gtk_selection_data_set_text.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_char_p,
                    ctypes.c_int,
                ]
                self.gtk.gtk_selection_data_set_text(
                    selection_data, self.text, len(self.text)
                )
            elif info == self.HTML_INFO and self.html is not None:
                self.gtk.gtk_selection_data_set.argtypes = [
                    ctypes.c_void_p,
                    ctypes.c_void_p,
                    ctypes.c_int,
                    ctypes.c_void_p,
                    ctypes.c_int,
                ]
                atom = self.gdk.gdk_atom_intern(b"text/html", 0)
                buf = ctypes.create_string_buffer(self.html)
                self.gtk.gtk_selection_data_set(
                    selection_data, atom, 8, buf, len(self.html)
                )

        @ClearFunc
        def on_clear(clipboard, user_data):
            self.lost = True

        self._on_get = on_get
        self._on_clear = on_clear
        entries = [
            GtkTargetEntry(b"UTF8_STRING", 0, self.TEXT_INFO),
            GtkTargetEntry(b"text/plain;charset=utf-8", 0, self.TEXT_INFO),
            GtkTargetEntry(b"TEXT", 0, self.TEXT_INFO),
        ]
        if self.html is not None:
            entries.append(GtkTargetEntry(b"text/html", 0, self.HTML_INFO))
        self._targets = (GtkTargetEntry * len(entries))(*entries)
        self.gtk.gtk_clipboard_set_with_data.restype = ctypes.c_int
        self.gtk.gtk_clipboard_set_with_data.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(GtkTargetEntry),
            ctypes.c_uint,
            GetFunc,
            ClearFunc,
            ctypes.c_void_p,
        ]
        self.glib.g_main_context_default.restype = ctypes.c_void_p
        self._ctx = self.glib.g_main_context_default()
        self.glib.g_main_context_iteration.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.glib.g_main_context_iteration.restype = ctypes.c_int

    def _set(self):
        ok = self.gtk.gtk_clipboard_set_with_data(
            self.clipboard,
            self._targets,
            len(self._targets),
            self._on_get,
            self._on_clear,
            None,
        )
        if not ok:
            raise RuntimeError("gtk_clipboard_set_with_data failed")
        for _ in range(10):
            self.glib.g_main_context_iteration(self._ctx, 0)

    def wait_for_restore(self):
        while True:
            self.glib.g_main_context_iteration(self._ctx, 0)
            ready, _, _ = select.select([sys.stdin], [], [], 0.05)
            if ready:
                line = sys.stdin.readline()
                if line == "" or line.strip() == "restore":
                    return
            if self.lost:
                # Keep pumping until the parent asks to finish.
                continue


def wait_for_restore_line():
    while True:
        line = sys.stdin.readline()
        if line == "" or line.strip() == "restore":
            return


def publish_temporary(backend, text, html):
    if html:
        try:
            holder = GtkClipboard(text, html)
            return ("gtk", holder, text)
        except Exception:
            # Plain text must still work when multi-format setup fails.
            pass
    if backend == "x11":
        xclip_set("UTF8_STRING", text)
        return ("x11", None, text)
    wl_set("text/plain;charset=utf-8", text)
    return ("wayland", None, text)


def main():
    backend = choose_backend()
    text = read_b64_line()
    html_raw = read_b64_line()
    html = html_raw if html_raw else None

    lock_fd = open(LOCK_PATH, "a+")
    try:
        acquire_lock(lock_fd)
        saved = snapshot_x11() if backend == "x11" else snapshot_wayland()
        try:
            kind, holder, expected = publish_temporary(backend, text, html)
        except Exception as error:
            try:
                if backend == "x11":
                    restore_x11(saved)
                else:
                    restore_wayland(saved)
            except Exception:
                pass
            fail(str(error))

        emit("ready")
        try:
            if kind == "gtk":
                holder.wait_for_restore()
                changed = holder.lost
            else:
                wait_for_restore_line()
                current = current_x11_text() if backend == "x11" else current_wayland_text()
                changed = current != expected

            if changed:
                emit("changed")
            else:
                if backend == "x11":
                    restore_x11(saved)
                else:
                    restore_wayland(saved)
                emit("restored")
        except Exception as error:
            emit("error", str(error))
            sys.exit(1)
    finally:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)
        except Exception:
            pass
        lock_fd.close()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as error:
        try:
            emit("error", str(error))
        except Exception:
            pass
        sys.exit(1)
`;

const LINUX_CLIPBOARD_HOST_COMMAND = `exec(__import__('base64').b64decode('${Buffer.from(
  LINUX_CLIPBOARD_HOST,
  "utf8",
).toString("base64")}').decode())`;

export const __testing = {
  beginNativeClipboardTransaction,
  beginWin32ClipboardTransaction,
  beginLinuxClipboardTransaction,
  windowsHtmlClipboardFormat,
  WIN32_CLIPBOARD_HOST,
  LINUX_CLIPBOARD_HOST,
};
