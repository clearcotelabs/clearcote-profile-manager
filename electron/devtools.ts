// A local DevTools endpoint for a launched profile, so Jet, the SDK or Playwright can attach to the
// window the app opened (`connectOverCDP("http://127.0.0.1:<port>")`).
//
// Port 0 lets the browser pick a free port, so two profiles never collide and a page cannot guess the
// port of a well-known default. The browser writes the port it chose to <user-data-dir>/DevToolsActivePort
// (first line: the port, second line: the browser target's path); a stale copy from an earlier launch is
// removed first, so the number read is always this launch's. The endpoint listens on 127.0.0.1 only, but
// any program on this PC can use it while the profile runs, which is why it is opt-in.

import fs from "node:fs";
import path from "node:path";

export const DEBUG_PORT_SWITCH = "--remote-debugging-port=0";
export const ACTIVE_PORT_FILE = "DevToolsActivePort";
export const PORT_WAIT_MS = 15_000;

/** True when the user's own extra flags already open a DevTools port (theirs wins, ours is not added). */
export function hasOwnDebugPort(extraArgs?: string[]): boolean {
  return !!extraArgs?.some((a) => /^--remote-debugging-port(=|$)/.test(a));
}

/** The flags a launch with automation adds: none when the user's extra flags already open a port. */
export function debugPortArgs(extraArgs?: string[]): string[] {
  return hasOwnDebugPort(extraArgs) ? [] : [DEBUG_PORT_SWITCH];
}

export function clearActivePort(userDataDir: string): void {
  try {
    fs.rmSync(path.join(userDataDir, ACTIVE_PORT_FILE), { force: true });
  } catch {
    // a read-only or vanished dir: the wait below simply finds nothing
  }
}

/** The port in a DevToolsActivePort file's text, or null when it is not one yet (the browser may be mid-write). */
export function parseActivePort(text: string): number | null {
  const first = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (!/^\d{1,5}$/.test(first)) return null;
  const port = Number(first);
  return port > 0 && port < 65536 ? port : null;
}

export function readActivePort(userDataDir: string): number | null {
  try {
    return parseActivePort(fs.readFileSync(path.join(userDataDir, ACTIVE_PORT_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function endpointFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Wait for the browser to write its port; null when it did not within the time, or stopped first. */
export async function waitForActivePort(
  userDataDir: string,
  opts: { timeoutMs?: number; alive?: () => boolean; intervalMs?: number } = {},
): Promise<number | null> {
  const until = Date.now() + (opts.timeoutMs ?? PORT_WAIT_MS);
  const every = opts.intervalMs ?? 100;
  for (;;) {
    const port = readActivePort(userDataDir);
    if (port) return port;
    if (opts.alive && !opts.alive()) return null;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, every));
  }
}
