// Why did a browser stop? Classifies an exit the app did not ask for.
//
// PURE — no `node:` imports — because the renderer imports it too (like fpargs.ts / proxyargs.ts):
// the main process sends the raw facts, the card words them.
//
// The facts that matter, measured rather than assumed:
//   - The engine's licence watchdog ends the browser with exit code 0 — the SAME code as
//     closing the window yourself — after printing WATCHDOG_MARKER to stderr. The marker is the
//     only way to tell them apart, which is why the launcher keeps a tail of stderr.
//   - Windows reports crashes as NTSTATUS values in the exit code (0xC0000005…); Node hands them
//     over as unsigned 32-bit numbers. Chromium's own result codes are small integers.
//   - A hard TerminateProcess (Task Manager "End task", or any tool that kills it) exits with 1,
//     Chromium's RESULT_CODE_KILLED.

export const WATCHDOG_MARKER = "[clearcote] licence: the run-token stopped refreshing";

export interface ExitFacts {
  code: number | null;
  signal: string | null;
  /** The last few KB the browser wrote to stderr. */
  stderrTail?: string;
  /** What the licence server said when it last refused a heartbeat, if it did. */
  leaseRefusal?: { status: number; code?: string; error?: string };
  /** How long the browser ran, in ms. */
  ranForMs?: number;
}

export type ExitKind =
  | "normal" // closed from its own window — nothing to report
  | "licence" // stopped by the licence watchdog
  | "crash" // an NTSTATUS / fatal signal
  | "killed" // ended from outside the app
  | "profile-in-use" // the data folder is already open in another browser
  | "unexpected"; // any other non-zero exit

export interface ExitReason {
  kind: ExitKind;
  /** Short, human name for the code, when there is one ("access violation"). */
  name?: string;
  /** The code as people search for it ("0xC0000005", "exit code 21", "SIGKILL"). */
  codeLabel?: string;
}

/** Windows NTSTATUS / Chromium crash codes a user can meet, by unsigned value. */
const NTSTATUS: Record<number, string> = {
  0xc0000005: "access violation",
  0xc00000fd: "stack overflow",
  0xc0000409: "security check failure", // __fastfail — how Chromium's CHECK()s end on Windows
  0x80000003: "breakpoint", // a DCHECK / debug trap
  0xc000001d: "illegal instruction",
  0xc0000135: "missing DLL",
  0xc0000142: "DLL failed to initialise",
  0xc0000374: "heap corruption",
  0xc0000017: "out of memory",
  0xe0000008: "out of memory", // Chromium's own OOM exception code
};

const FATAL_SIGNALS = new Set(["SIGSEGV", "SIGABRT", "SIGILL", "SIGBUS", "SIGFPE", "SIGTRAP"]);

/** Chromium's result code when the profile's data folder is already open in another browser. */
export const RESULT_CODE_PROFILE_IN_USE = 21;

const hex = (n: number) => "0x" + n.toString(16).toUpperCase().padStart(8, "0");

export function classifyExit(f: ExitFacts): ExitReason {
  if ((f.stderrTail ?? "").includes(WATCHDOG_MARKER)) return { kind: "licence" };

  if (f.signal) {
    if (FATAL_SIGNALS.has(f.signal)) return { kind: "crash", codeLabel: f.signal };
    // SIGTERM / SIGKILL / SIGINT from something that is not this app.
    return { kind: "killed", codeLabel: f.signal };
  }

  const code = f.code == null ? 0 : f.code >>> 0;
  if (code === 0) return { kind: "normal" };
  if (NTSTATUS[code]) return { kind: "crash", name: NTSTATUS[code], codeLabel: hex(code) };
  if (code >= 0xc0000000) return { kind: "crash", codeLabel: hex(code) };
  if (code === 1) return { kind: "killed", codeLabel: "exit code 1" };
  if (code === RESULT_CODE_PROFILE_IN_USE) return { kind: "profile-in-use", codeLabel: `exit code ${code}` };
  return { kind: "unexpected", codeLabel: `exit code ${code}` };
}

/** Keeps the last `max` characters written to a stream. */
export class Tail {
  private buf = "";
  constructor(private readonly max = 8192) {}
  push(chunk: string | Uint8Array): void {
    this.buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    if (this.buf.length > this.max) this.buf = this.buf.slice(this.buf.length - this.max);
  }
  text(): string {
    return this.buf;
  }
}
