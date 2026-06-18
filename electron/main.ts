import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import * as geo from "./geo";
import { readSettings, writeSettings, ensureDirs } from "./store";
import type { Profile, Settings } from "./types";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

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
      redact && p.proxy ? { ...p, proxy: { ...p.proxy, password: p.proxy.password ? "" : undefined } } : p,
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
