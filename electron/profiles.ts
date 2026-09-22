import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR, ensureDirs } from "./store";
import { parseProxy, redactProxyString } from "./proxyargs";
import type { LastGeo, Profile } from "./types";

const EXAMPLE = "example.profile.json";

/** Deleted profiles wait here (as `<id>__<ms>/`) so a delete can be undone. Purged after a while. */
export const TRASH_DIR_NAME = ".trash";
/** How long a deleted profile stays restorable. The UI offers undo for seconds; the margin covers a
 *  slow click and an app that is closed right after deleting. */
export const TRASH_TTL_MS = 10 * 60 * 1000;

/** A profile id names a file and a folder, so it must stay one path segment. Imported JSON used to
 *  put its `id` straight into a path — "../../x" would have written outside the profiles folder. */
export function isSafeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 120 &&
    !/[\\/:*?"<>|]/.test(id) &&
    ![...id].some((ch) => ch.charCodeAt(0) < 32) && // control characters
    id !== "." &&
    id !== ".." &&
    !id.startsWith(".")
  );
}

function profilePath(id: string): string {
  if (!isSafeId(id)) throw new Error(`Invalid profile id: ${JSON.stringify(id)}`);
  return path.join(PROFILES_DIR, `${id}.json`);
}

export function listProfiles(): Profile[] {
  ensureDirs();
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json") && f !== EXAMPLE)
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), "utf8")) as Profile;
      } catch {
        return null;
      }
    })
    .filter((p): p is Profile => p !== null)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

export function getProfile(id: string): Profile | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(id), "utf8")) as Profile;
  } catch {
    return null;
  }
}

export function saveProfile(p: Profile): Profile {
  ensureDirs();
  const now = new Date().toISOString();
  const out: Profile = {
    ...p,
    createdAt: p.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(profilePath(out.id), JSON.stringify(out, null, 2), "utf8");
  return out;
}

/**
 * Record a launch on the profile AS IT IS ON DISK, touching only lastLaunchedAt.
 *
 * The renderer used to save its own copy of the profile after a launch — the copy it held when
 * Launch was clicked. A first launch downloads for minutes, and an edit saved in that window was
 * silently overwritten by the stale copy. It also bumped updatedAt, so "last edited" meant "last
 * launched". Returns null when there is no such profile (never throws: a launch has already
 * happened and must not be reported as failed over bookkeeping).
 */
export function markLaunched(id: string, at = new Date().toISOString()): Profile | null {
  try {
    const cur = getProfile(id);
    if (!cur) return null;
    const out: Profile = { ...cur, lastLaunchedAt: at };
    fs.writeFileSync(profilePath(id), JSON.stringify(out, null, 2), "utf8");
    return out;
  } catch {
    return null;
  }
}

/** "scheme host:port" — how a proxy is identified without its credentials. */
export function proxyKey(proxy: unknown): string {
  const p = parseProxy(proxy);
  return p ? `${p.scheme} ${p.host}:${p.port}` : "";
}

/**
 * Keep a proxy exit lookup on the saved profile (lastGeo only — same discipline as markLaunched),
 * so the card can say where the traffic goes. Quiet no-op for an unknown profile or a failed lookup.
 */
export function recordGeo(
  id: string,
  geo: { ok: boolean; ip?: string; country?: string; countryCode?: string; city?: string },
  proxy: unknown,
  at = new Date().toISOString(),
): Profile | null {
  if (!geo.ok) return null;
  try {
    const cur = getProfile(id);
    if (!cur) return null;
    const lastGeo: LastGeo = {
      ip: geo.ip,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      at,
      proxy: proxyKey(proxy),
    };
    const out: Profile = { ...cur, lastGeo };
    fs.writeFileSync(profilePath(id), JSON.stringify(out, null, 2), "utf8");
    return out;
  } catch {
    return null;
  }
}

/**
 * Rename a group on every profile in it. Groups are matched the way the list shows them — trimmed,
 * case-insensitive — so "Work" and "work " both move. Renaming to "" takes them out of any group.
 * Returns how many profiles changed. updatedAt is left alone: the profiles themselves did not change.
 */
export function renameGroup(from: string, to: string): number {
  const key = from.trim().toLowerCase();
  if (!key) return 0;
  const next = to.trim();
  let n = 0;
  for (const p of listProfiles()) {
    if ((p.group ?? "").trim().toLowerCase() !== key) continue;
    const out: Profile = { ...p, group: next || undefined };
    if (!next) delete out.group;
    fs.writeFileSync(profilePath(p.id), JSON.stringify(out, null, 2), "utf8");
    n++;
  }
  return n;
}

/**
 * The profiles as they go into an export file. Secrets are left out unless asked for: an export is
 * what people paste into a ticket, but it is also how a set moves to a new machine, and there the
 * proxy passwords and the cookie encryption key are exactly what must come along.
 */
export function exportList(list: Profile[], opts: { includeSecrets?: boolean } = {}): Profile[] {
  if (opts.includeSecrets) return list;
  return list.map((p) => {
    const out = { ...p };
    if (out.proxy) out.proxy = redactProxyString(out.proxy);
    delete out.encryptionKey;
    return out;
  });
}

/** Total size of a directory tree, without blocking the main process on a big profile. */
export async function dirSizeAsync(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (e) => {
        const p = path.join(d, e.name);
        if (e.isDirectory()) return walk(p);
        try {
          // Await FIRST: `total += await …` reads `total` before the await, so parallel stats would
          // overwrite each other's additions (a test caught exactly that: 1530 of 5599 bytes).
          const { size } = await fs.promises.stat(p);
          total += size;
        } catch {
          /* vanished or locked */
        }
      }),
    );
  };
  await walk(dir);
  return total;
}

/** Where a profile's browser data lives. */
export function userDataDirOf(p: Pick<Profile, "id" | "userDataDir">): string {
  return p.userDataDir || path.join(PROFILES_DIR, p.id, "userdata");
}

/**
 * What "clear cache" removes inside each Chromium profile (Default, Profile 1…): caches the browser
 * rebuilds on its own. Cookies, Login Data, Local Storage, IndexedDB, Session Storage, History,
 * Preferences and Extensions are NOT here — clearing the cache keeps you signed in.
 */
export const CACHE_DIRS_PER_PROFILE = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  path.join("Service Worker", "CacheStorage"),
  path.join("Service Worker", "ScriptCache"),
];
/** The same, at the top of the user-data dir (shared by all Chromium profiles in it). */
export const CACHE_DIRS_TOP = ["GrShaderCache", "GraphiteDawnCache", "ShaderCache", "component_crx_cache", "extensions_crx_cache"];

/** Delete the browser caches under a user-data dir; returns the bytes freed. The caller must make
 *  sure the browser is not running (its files are open on Windows). */
export async function clearBrowsingCache(userDataDir: string): Promise<number> {
  const targets: string[] = CACHE_DIRS_TOP.map((d) => path.join(userDataDir, d));
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(userDataDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const prof = path.join(userDataDir, e.name);
    // A Chromium profile directory is the one holding a Preferences file.
    if (!fs.existsSync(path.join(prof, "Preferences"))) continue;
    for (const d of CACHE_DIRS_PER_PROFILE) targets.push(path.join(prof, d));
  }
  let freed = 0;
  for (const t of targets) {
    if (!fs.existsSync(t)) continue;
    freed += await dirSizeAsync(t);
    await fs.promises.rm(t, { recursive: true, force: true });
  }
  return freed;
}

export function deleteProfile(id: string): void {
  try {
    fs.rmSync(profilePath(id), { force: true });
  } catch {
    /* ignore */
  }
  // remove the profile's persistent browser data too
  try {
    fs.rmSync(path.join(PROFILES_DIR, id), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** A fresh, unused id for a profile called `name`. */
export function freshId(name: string | undefined): string {
  let id = "";
  do id = `${slug(name || "profile") || "profile"}-${Math.random().toString(36).slice(2, 6)}`;
  while (getProfile(id));
  return id;
}

/**
 * Save profiles from an import file. Anything without a seed is not a profile and is skipped.
 *
 * An imported id is a path segment on disk, so an unsafe one is replaced; one already in use is
 * replaced too. Import used to overwrite the existing profile of that id without a word, which made
 * re-importing an old export silent data loss.
 */
export function importProfiles(items: unknown[]): { count: number; renamed: number } {
  let count = 0;
  let renamed = 0;
  for (const raw of items) {
    const p = raw as Profile | null;
    if (!p || typeof p !== "object" || !p.fingerprint) continue;
    let id = p.id;
    if (!isSafeId(id) || getProfile(id)) {
      if (id) renamed++;
      id = freshId(p.name);
    }
    saveProfile({ ...p, id });
    count++;
  }
  return { count, renamed };
}

export type TrashResult = { ok: true; trashId: string } | { ok: false; error: string };

/**
 * Delete a profile recoverably: move its JSON and its browser data into the trash.
 *
 * All-or-nothing — if the data folder cannot move (a browser still has it open on Windows), the
 * JSON is put back and nothing is lost.
 */
export function trashProfile(id: string, now = Date.now()): TrashResult {
  if (!isSafeId(id)) return { ok: false, error: "Invalid profile id." };
  const json = profilePath(id);
  if (!fs.existsSync(json)) return { ok: false, error: "That profile no longer exists." };
  const trashId = `${id}__${now}`;
  const dest = path.join(PROFILES_DIR, TRASH_DIR_NAME, trashId);
  fs.mkdirSync(dest, { recursive: true });
  try {
    fs.renameSync(json, path.join(dest, "profile.json"));
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    return { ok: false, error: `Could not delete the profile: ${String((e as Error)?.message || e)}` };
  }
  const data = path.join(PROFILES_DIR, id);
  if (fs.existsSync(data)) {
    try {
      fs.renameSync(data, path.join(dest, "data"));
    } catch {
      fs.renameSync(path.join(dest, "profile.json"), json);
      fs.rmSync(dest, { recursive: true, force: true });
      return {
        ok: false,
        error: "Its browser data is in use — close the browser using this profile, then delete it again.",
      };
    }
  }
  return { ok: true, trashId };
}

export type RestoreResult = { ok: true; profile: Profile } | { ok: false; error: string };

/** Undo a trashProfile(). Refuses to overwrite a profile that took the same id in the meantime. */
export function restoreProfile(trashId: string): RestoreResult {
  const m = /^(.+)__(\d+)$/.exec(trashId || "");
  if (!m || !isSafeId(trashId) || !isSafeId(m[1])) return { ok: false, error: "Invalid trash entry." };
  const id = m[1];
  const src = path.join(PROFILES_DIR, TRASH_DIR_NAME, trashId);
  if (!fs.existsSync(path.join(src, "profile.json"))) return { ok: false, error: "It can no longer be restored." };
  if (fs.existsSync(profilePath(id)) || fs.existsSync(path.join(PROFILES_DIR, id))) {
    return { ok: false, error: `A profile named “${id}” exists again, so this one was not restored over it.` };
  }
  try {
    fs.renameSync(path.join(src, "profile.json"), profilePath(id));
    if (fs.existsSync(path.join(src, "data"))) fs.renameSync(path.join(src, "data"), path.join(PROFILES_DIR, id));
    fs.rmSync(src, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `Could not restore it: ${String((e as Error)?.message || e)}` };
  }
  const p = getProfile(id);
  return p ? { ok: true, profile: p } : { ok: false, error: "Restored, but the profile could not be read." };
}

/** Permanently remove trash entries older than `maxAgeMs`. Best-effort; returns what it removed. */
export function purgeTrash(maxAgeMs = TRASH_TTL_MS, now = Date.now()): string[] {
  const root = path.join(PROFILES_DIR, TRASH_DIR_NAME);
  const removed: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const name of entries) {
    const at = Number(/__(\d+)$/.exec(name)?.[1]);
    if (Number.isFinite(at) && now - at < maxAgeMs) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* in use — next purge */
    }
  }
  return removed;
}
