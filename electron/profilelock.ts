// Is this profile's data folder already open in another browser?
//
// WHY. A second browser started on a data folder that is already open does not run: Chromium hands its
// command line to the window that has the folder and exits, on Windows with exit code 0 (measured on
// Chromium 1228, 2026-11-28; not the 21 of RESULT_CODE_PROFILE_IN_USE). Code 0 reads as "closed from its own
// window", so the launch looked like it worked, the card said nothing, and a launch that held its first tab
// reported "The wait for Chrome's certificate revocation list failed (the browser closed the DevTools pipe)".
// Asking first lets the card say what is going on, before a licence slot is taken.
//
// HOW (Windows). The browser that has the folder keeps `<userDataDir>/lockfile` open for writing with read-only
// sharing and FILE_FLAG_DELETE_ON_CLOSE, so opening it for writing fails with EBUSY while that browser runs, and
// the file is gone once it stops, even after a hard kill (both measured). Opening it changes nothing in it.
// macOS and Linux use a SingletonLock symlink whose pid can be stale or reused: not checked here, so a launch
// there goes ahead as before.

import { closeSync, openSync } from "node:fs";
import path from "node:path";

export const LOCK_FILE = "lockfile";

export function dataFolderInUse(userDataDir: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  try {
    closeSync(openSync(path.join(userDataDir, LOCK_FILE), "r+"));
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EBUSY";
  }
}
