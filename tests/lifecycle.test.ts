// A browser's life around the app: why it stopped (exitreason.ts), how the app stops it
// (procstop.ts), and what closing the window does while browsers run (closeguard.ts).

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { classifyExit, Tail, WATCHDOG_MARKER, RESULT_CODE_PROFILE_IN_USE } from "../electron/exitreason";
import { stopGracefully } from "../electron/procstop";
import { closeAction, askText, ASK_BUTTONS } from "../electron/closeguard";

// The watchdog's own stderr line, exactly as the engine prints it.
const WATCHDOG_LINE =
  "[clearcote] licence: the run-token stopped refreshing (revoked, checked in, or over the concurrency limit); stopping.";

describe("classifyExit", () => {
  it("the marker matches the engine's real line", () => {
    expect(WATCHDOG_LINE.startsWith(WATCHDOG_MARKER)).toBe(true);
  });

  it("exit 0 is a normal close — unless the watchdog said it stopped the browser (it also exits 0)", () => {
    expect(classifyExit({ code: 0, signal: null })).toEqual({ kind: "normal" });
    expect(classifyExit({ code: 0, signal: null, stderrTail: "noise\n" + WATCHDOG_LINE + "\n" })).toEqual({ kind: "licence" });
  });

  it("Windows crash codes, as Node reports them (unsigned) and as a negative int32", () => {
    expect(classifyExit({ code: 3221225477, signal: null })).toEqual({ kind: "crash", name: "access violation", codeLabel: "0xC0000005" });
    expect(classifyExit({ code: 0xc0000005 | 0, signal: null })).toMatchObject({ kind: "crash", codeLabel: "0xC0000005" }); // -1073741819
    expect(classifyExit({ code: 0x80000003, signal: null })).toMatchObject({ kind: "crash", name: "breakpoint" });
    expect(classifyExit({ code: 0xc0000409, signal: null })).toMatchObject({ kind: "crash", name: "security check failure" });
    expect(classifyExit({ code: 0xe0000008, signal: null })).toMatchObject({ kind: "crash", name: "out of memory" });
    expect(classifyExit({ code: 0xc0001234, signal: null })).toEqual({ kind: "crash", codeLabel: "0xC0001234" });
  });

  it("exit 1 is Chromium's RESULT_CODE_KILLED — ended from outside (Task Manager, TerminateProcess)", () => {
    expect(classifyExit({ code: 1, signal: null })).toEqual({ kind: "killed", codeLabel: "exit code 1" });
  });

  it("the profile-in-use code, and any other non-zero code", () => {
    expect(classifyExit({ code: RESULT_CODE_PROFILE_IN_USE, signal: null }).kind).toBe("profile-in-use");
    expect(classifyExit({ code: 7, signal: null })).toEqual({ kind: "unexpected", codeLabel: "exit code 7" });
  });

  it("signals: fatal ones are crashes, the rest came from outside", () => {
    expect(classifyExit({ code: null, signal: "SIGSEGV" })).toEqual({ kind: "crash", codeLabel: "SIGSEGV" });
    expect(classifyExit({ code: null, signal: "SIGABRT" }).kind).toBe("crash");
    expect(classifyExit({ code: null, signal: "SIGKILL" })).toEqual({ kind: "killed", codeLabel: "SIGKILL" });
    expect(classifyExit({ code: null, signal: "SIGTERM" }).kind).toBe("killed");
  });
});

describe("Tail", () => {
  it("keeps only the last N characters, across chunks and byte buffers", () => {
    const t = new Tail(10);
    t.push("0123456789");
    t.push(Buffer.from("abc"));
    expect(t.text()).toBe("3456789abc");
    t.push("x".repeat(50));
    expect(t.text()).toBe("x".repeat(10));
  });
});

/** A stand-in ChildProcess: exits when told to, or never. */
function fakeChild(opts: { closesOnRequest: boolean; pid?: number }) {
  const c = new EventEmitter() as EventEmitter & ChildProcess;
  Object.assign(c, { pid: opts.pid ?? 4242, exitCode: null, signalCode: null });
  const exit = (code: number | null, signal: string | null) => {
    Object.assign(c, { exitCode: code, signalCode: signal });
    c.emit("exit", code, signal);
  };
  (c as unknown as { kill: (s?: string) => boolean }).kill = vi.fn((s?: string) => {
    setTimeout(() => exit(s === "SIGKILL" ? null : 1, s === "SIGKILL" ? "SIGKILL" : null), 5);
    return true;
  });
  const requestClose = vi.fn(() => {
    if (opts.closesOnRequest) setTimeout(() => exit(0, null), 20);
  });
  return { child: c, requestClose, exit };
}

describe("stopGracefully", () => {
  it("asks politely and returns 'graceful' when the browser closes itself — never kills it", async () => {
    const { child, requestClose } = fakeChild({ closesOnRequest: true });
    expect(await stopGracefully(child, { requestClose, timeoutMs: 2000 })).toBe("graceful");
    expect(requestClose).toHaveBeenCalledWith(4242);
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.exitCode).toBe(0);
  });

  it("forces it after the timeout when it will not close (a 'Leave site?' prompt, a hang)", async () => {
    const { child, requestClose } = fakeChild({ closesOnRequest: false });
    const t0 = Date.now();
    expect(await stopGracefully(child, { requestClose, timeoutMs: 150, platform: "win32" })).toBe("forced");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140);
    expect(child.kill).toHaveBeenCalledWith(); // Windows: TerminateProcess, no signal
  });

  it("off Windows the force is SIGKILL (SIGTERM was the polite request)", async () => {
    const { child, requestClose } = fakeChild({ closesOnRequest: false });
    expect(await stopGracefully(child, { requestClose, timeoutMs: 50, platform: "linux" })).toBe("forced");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("an already-exited browser is 'gone' and nothing is sent", async () => {
    const { child, requestClose, exit } = fakeChild({ closesOnRequest: true });
    exit(0, null);
    expect(await stopGracefully(child, { requestClose })).toBe("gone");
    expect(requestClose).not.toHaveBeenCalled();
  });

  it("a failing close request still ends in a force, not a hang", async () => {
    const { child } = fakeChild({ closesOnRequest: false });
    const requestClose = vi.fn(() => {
      throw new Error("taskkill missing");
    });
    expect(await stopGracefully(child, { requestClose, timeoutMs: 50, platform: "win32" })).toBe("forced");
  });
});

describe("closeAction — closing the window with browsers open", () => {
  it("nothing running, or already quitting: just close", () => {
    expect(closeAction(0, "ask", false)).toBe("close");
    expect(closeAction(0, "tray", false)).toBe("close");
    expect(closeAction(3, "ask", true)).toBe("close");
  });
  it("browsers running: follow the remembered choice, else ask", () => {
    expect(closeAction(1, undefined, false)).toBe("ask");
    expect(closeAction(1, "ask", false)).toBe("ask");
    expect(closeAction(2, "tray", false)).toBe("tray");
    expect(closeAction(2, "quit", false)).toBe("stop-and-quit");
  });
  it("the question counts the browsers and names the free-plan consequence", () => {
    expect(askText(1).message).toBe("1 browser is still running.");
    expect(askText(3).message).toBe("3 browsers are still running.");
    expect(askText(2).detail).toMatch(/free plan stops by itself within a few minutes/);
    expect(ASK_BUTTONS).toEqual(["Keep running in the tray", "Close browsers and quit", "Cancel"]);
  });
});
