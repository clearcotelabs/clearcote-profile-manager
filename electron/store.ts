import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "./types";

const isDev = process.env.ELECTRON_DEV === "1";

// In dev, keep profiles in the project repo dir (visible alongside example.profile.json);
// in the packaged app, use the OS userData dir.
export const ROOT = isDev ? process.cwd() : app.getPath("userData");
export const PROFILES_DIR = path.join(ROOT, "profiles");
export const SETTINGS_PATH = path.join(app.getPath("userData"), "settings.json");

export function ensureDirs(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

export function readSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return { theme: "dark" };
  }
}

export function writeSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf8");
}
