import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import * as geo from "./geo";
import { readSettings, writeSettings, ensureDirs, FINGERPRINTS_DIR } from "./store";
import { redactProxyString } from "./proxy";
import type { Profile, Settings, FingerprintMeta } from "./types";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

const CLEARCOTE_PROFILES_REPO = "clearcotelabs/clearcote-profiles";

/** Validate a parsed JSON looks like a clearcote-profile and summarize it for display. */
function summarizeFingerprint(obj: unknown): { ok: boolean; meta?: FingerprintMeta } {
  if (!obj || typeof obj !== "object") return { ok: false };
  const o = obj as Record<string, any>;
  const looksLikeProfile = !!(o.webgl || o.screen || o.hardware_concurrency != null);
  if (!looksLikeProfile) return { ok: false };
  const debug = o.webgl?.webgl1?.debug || {};
  const sc = o.screen || {};
  return {
    ok: true,
    meta: {
      label: o.meta?.id || undefined,
      renderer: debug.UNMASKED_RENDERER_WEBGL || undefined,
      cores: typeof o.hardware_concurrency === "number" ? o.hardware_concurrency : undefined,
      memory: typeof o.device_memory === "number" ? o.device_memory : undefined,
      screen: sc.width && sc.height ? `${sc.width}x${sc.height}` : undefined,
    },
  };
}

/** Persist a captured-profile JSON into the shared fingerprints dir; returns its filename + meta. */
function storeFingerprint(name: string, json: string, source: "file" | "library") {
  fs.mkdirSync(FINGERPRINTS_DIR, { recursive: true });
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.json$/i, "");
  const file = `${base}.json`;
  fs.writeFileSync(path.join(FINGERPRINTS_DIR, file), json, "utf8");
  const sum = summarizeFingerprint(JSON.parse(json));
  return { file, meta: { ...(sum.meta || {}), source } as FingerprintMeta };
}

const isDev = process.env.ELECTRON_DEV === "1";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#07080a", // Ink
    title: "Clearcote Profile Manager",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:3000");
  } else {
    win.loadFile(path.join(__dirname, "..", "out", "index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("profiles:list", () => profiles.listProfiles());
  ipcMain.handle("profiles:get", (_e, id: string) => profiles.getProfile(id));
  ipcMain.handle("profiles:save", (_e, p: Profile) => profiles.saveProfile(p));
  ipcMain.handle("profiles:delete", (_e, id: string) => profiles.deleteProfile(id));

  ipcMain.handle("launch", (_e, p: Profile) => launcher.launch(p));
  ipcMain.handle("stop", (_e, id: string) => launcher.stop(id));
  ipcMain.handle("running", () => launcher.listRunning());

  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => {
    writeSettings(s);
    return readSettings();
  });

  ipcMain.handle("resolveBinary", () => launcher.resolveBinary());
  ipcMain.handle("pickBinary", async () => {
    const r = await dialog.showOpenDialog({
      title: "Select the Clearcote chrome.exe",
      properties: ["openFile"],
      filters: [{ name: "Clearcote browser", extensions: ["exe"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = readSettings();
    s.binaryPath = r.filePaths[0];
    writeSettings(s);
    return r.filePaths[0];
  });

  ipcMain.handle("geo:check", (_e, p: Profile) => geo.geoCheck(p));

  ipcMain.handle("profiles:export", async (_e, opts?: { redact?: boolean }) => {
    const r = await dialog.showSaveDialog({
      title: "Export profiles",
      defaultPath: "clearcote-profiles.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    const redact = opts?.redact !== false; // redact proxy passwords by default
    const list = profiles.listProfiles().map((p) =>
      redact && p.proxy ? { ...p, proxy: redactProxyString(p.proxy) } : p,
    );
    fs.writeFileSync(r.filePath, JSON.stringify(list, null, 2), "utf8");
    return { ok: true, path: r.filePath, count: list.length };
  });

  ipcMain.handle("profiles:import", async () => {
    const r = await dialog.showOpenDialog({
      title: "Import profiles",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      const data = JSON.parse(fs.readFileSync(r.filePaths[0], "utf8"));
      const arr: Profile[] = Array.isArray(data) ? data : [data];
      let count = 0;
      for (const p of arr) {
        if (p && p.fingerprint) {
          profiles.saveProfile({
            ...p,
            id: p.id || `${slug(p.name || "profile") || "profile"}-${Math.random().toString(36).slice(2, 6)}`,
          });
          count++;
        }
      }
      return { ok: true, count };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  // ---- captured fingerprint profiles (clearcote-profiles) ----
  ipcMain.handle("fp:import", async () => {
    const r = await dialog.showOpenDialog({
      title: "Import a captured fingerprint profile",
      properties: ["openFile"],
      filters: [{ name: "clearcote-profile JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    try {
      const json = fs.readFileSync(r.filePaths[0], "utf8");
      if (!summarizeFingerprint(JSON.parse(json)).ok)
        return { ok: false, error: "Not a clearcote-profile (missing webgl/screen/hardware fields)." };
      const { file, meta } = storeFingerprint(path.basename(r.filePaths[0]), json, "file");
      return { ok: true, file, meta };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("fp:library", async () => {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${CLEARCOTE_PROFILES_REPO}/contents/samples`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "clearcote-profile-manager" } },
      );
      if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
      const items = (await res.json()) as Array<{ name: string; download_url: string }>;
      const list = (Array.isArray(items) ? items : [])
        .filter((it) => typeof it.name === "string" && it.name.endsWith(".json"))
        .map((it) => ({ name: it.name, downloadUrl: it.download_url }));
      return { ok: true, profiles: list };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  ipcMain.handle("fp:use", async (_e, lib: { name: string; downloadUrl: string }) => {
    try {
      const res = await fetch(lib.downloadUrl, { headers: { "User-Agent": "clearcote-profile-manager" } });
      if (!res.ok) return { ok: false, error: `download failed (${res.status})` };
      const json = await res.text();
      if (!summarizeFingerprint(JSON.parse(json)).ok)
        return { ok: false, error: "Downloaded file is not a clearcote-profile." };
      const { file, meta } = storeFingerprint(lib.name, json, "library");
      return { ok: true, file, meta };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}

app.whenReady().then(() => {
  ensureDirs();
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
