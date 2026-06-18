import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import { readSettings, writeSettings, ensureDirs } from "./store";
import type { Profile, Settings } from "./types";

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
