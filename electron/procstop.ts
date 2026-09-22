// Stopping a browser the way a person closing it would.
//
// `child.kill()` on Windows is TerminateProcess — a hard kill. Chromium never runs its shutdown, so
// it records the session as crashed ("exit_type": "Crashed" in Preferences, measured), offers
// "Restore pages?" on the next launch, and loses whatever it had not flushed to disk yet.
//
// Instead: ask the browser to close (Windows: taskkill WITHOUT /F, which posts WM_CLOSE to the
// process's windows — the same message the window's ✕ sends; elsewhere: SIGTERM, which Chromium
// treats as a normal shutdown), wait, and only force it when it has not gone after `timeoutMs`
// (a page's "Leave site?" prompt, or a hung browser).

import { spawn, type ChildProcess } from "node:child_process";

export type StopOutcome = "graceful" | "forced" | "gone";

export interface StopOptions {
  /** How long to wait for a graceful exit before forcing. */
  timeoutMs?: number;
  /** Ask the process to close. Injected by tests; defaults to the platform's polite request. */
  requestClose?: (pid: number) => Promise<void> | void;
  platform?: NodeJS.Platform;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The polite request: WM_CLOSE via taskkill on Windows, SIGTERM elsewhere. */
export function requestCloseDefault(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    return new Promise((resolve) => {
      // No /F (that would be TerminateProcess again) and no /T (renderers have no windows; the
      // browser process ends them itself on a clean shutdown).
      const p = spawn("taskkill", ["/PID", String(pid)], { stdio: "ignore", windowsHide: true });
      p.on("exit", () => resolve());
      p.on("error", () => resolve());
    });
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  return Promise.resolve();
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export async function stopGracefully(child: ChildProcess, opts: StopOptions = {}): Promise<StopOutcome> {
  if (hasExited(child) || !child.pid) return "gone";
  const platform = opts.platform ?? process.platform;
  const exited = new Promise<void>((resolve) => {
    if (hasExited(child)) resolve();
    else child.once("exit", () => resolve());
  });

  try {
    await (opts.requestClose ?? ((pid: number) => requestCloseDefault(pid, platform)))(child.pid);
  } catch {
    /* fall through to the wait, then force */
  }
  const closed = await Promise.race([exited.then(() => true), sleep(opts.timeoutMs ?? 8000).then(() => false)]);
  if (closed) return "graceful";

  try {
    // Windows has no signals: kill() is TerminateProcess. Elsewhere SIGKILL, since SIGTERM was
    // already the polite request and it was not enough.
    if (platform === "win32") child.kill();
    else child.kill("SIGKILL");
  } catch {
    /* raced with its exit */
  }
  await Promise.race([exited, sleep(3000)]);
  return "forced";
}
