// The Windows tray icon: how the helper runs without a console window.
//
// "Clearcote Helper.cmd" starts the helper with --tray. That first process (in the console window)
// starts a second copy of itself with --background: detached, so it has no console at all, its
// output going to helper-log.txt in the data folder. The first one waits until the second is
// listening, then exits, and the console window closes.
//
// The background helper starts tray/clearcote-tray.ps1 (shipped in the download, plain text: read
// it) with Windows PowerShell, hidden. That script shows the icon and its menu (Open status page,
// Paired sites…, Quit) and talks to the helper over http://127.0.0.1:<port>/tray/* only. Those two
// routes need a token made fresh for each run and handed to the script in its environment
// (TRAY_TOKEN_ENV), in a header (TRAY_HEADER) and with no Origin header at all: a web page cannot
// send a request without Origin to another site, and does not know the token (server.ts).
//
// The two processes end together: the script exits when the helper's process is gone, and the
// helper quits (closing its browsers properly, as closing the console does) when the script exits.

import crypto from "node:crypto";
import path from "node:path";

/** The environment variable the tray script reads its token from. */
export const TRAY_TOKEN_ENV = "CLEARCOTE_HELPER_TRAY_TOKEN";
/** The header the tray script sends its token in. */
export const TRAY_HEADER = "x-clearcote-tray";
/** Where the download keeps the tray script, relative to lib/clearcote-helper.js. */
export const TRAY_SCRIPT = path.join("..", "tray", "clearcote-tray.ps1");
/** The background helper's output, in the data folder. */
export const LOG_FILE = "helper-log.txt";

export function newTrayToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** The tray script's token check: constant time, and nothing passes when no token was set. */
export function trayTokenOk(given: string | string[] | undefined, expected: string | undefined): boolean {
  if (!expected || typeof given !== "string" || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The arguments for the background copy: the same options, --tray swapped for --background. */
export function backgroundArgs(argv: string[]): string[] {
  return [...argv.filter((a) => a !== "--tray" && a !== "--background"), "--background"];
}

/**
 * How the helper starts the tray script: Windows PowerShell by its full path (not whatever
 * powershell.exe comes first on PATH), no profile, hidden, the script by path. ExecutionPolicy
 * Bypass applies to this one process only; without it the default policy refuses any script file.
 */
export function trayCommand(o: { script: string; port: number; helperPid: number; systemRoot?: string }): { file: string; args: string[] } {
  const root = o.systemRoot || "C:\\Windows";
  return {
    file: path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      o.script,
      "-Port",
      String(o.port),
      "-HelperPid",
      String(o.helperPid),
    ],
  };
}

/** The icon's tooltip. Windows cuts tooltips at 63 characters; this stays well under. */
export function trayTooltip(browsers: number): string {
  const base = "Clearcote Helper \u2014 running";
  if (!browsers) return base;
  return `${base} \u00b7 ${browsers} browser${browsers === 1 ? "" : "s"} open`;
}
