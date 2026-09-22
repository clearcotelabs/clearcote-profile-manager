import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR, ensureDirs } from "./store";
import type { Profile } from "./types";

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
