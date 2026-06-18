import fs from "node:fs";
import path from "node:path";
import { PROFILES_DIR, ensureDirs } from "./store";
import type { Profile } from "./types";

const EXAMPLE = "example.profile.json";

function profilePath(id: string): string {
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
