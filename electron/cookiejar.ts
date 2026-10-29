// Imported cookies waiting for a profile's next launch.
//
// Cookies can't be written into the browser's own cookie database from outside: it is SQLite with values
// sealed by a key the OS (or the profile) holds. So an import is parked next to the profile's data, and the
// launch that finds it opens the DevTools pipe, sets each cookie before the first page loads, and removes
// the file. A cookie the browser refuses is counted and said, never retried forever.

import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR } from "./store";
import { isSafeId } from "./profiles";
import { mergeCookies, type ImportedCookie } from "./migrate";
import type { PipeCdp } from "./crlset";

export const PENDING_FILE = "import-cookies.json";

function pendingPath(id: string): string {
  if (!isSafeId(id)) throw new Error(`Invalid profile id: ${JSON.stringify(id)}`);
  return path.join(PROFILES_DIR, id, PENDING_FILE);
}

export function readPending(id: string): ImportedCookie[] {
  try {
    const v = JSON.parse(fs.readFileSync(pendingPath(id), "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Add cookies to the profile's pending import (same name/domain/path: the new one wins). Returns the total. */
export function addPending(id: string, cookies: ImportedCookie[]): number {
  const all = mergeCookies(readPending(id), cookies);
  const file = pendingPath(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all), "utf8");
  return all.length;
}

export function clearPending(id: string): void {
  try {
    fs.rmSync(pendingPath(id), { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Set the cookies through the browser's DevTools pipe. One per call: Storage.setCookies refuses a whole
 * batch for one bad cookie, and a few thousand calls over a local pipe take well under a second.
 */
export async function injectCookies(cdp: Pick<PipeCdp, "send">, cookies: ImportedCookie[]): Promise<{ set: number; refused: number }> {
  let set = 0;
  let refused = 0;
  for (const c of cookies) {
    try {
      await cdp.send("Storage.setCookies", { cookies: [c] });
      set++;
    } catch (e) {
      if (/closed the DevTools pipe/.test(String((e as Error)?.message))) throw e;
      refused++;
    }
  }
  return { set, refused };
}
