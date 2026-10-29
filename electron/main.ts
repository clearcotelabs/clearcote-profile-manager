import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, screen, type NativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import { readSettings, writeSettings } from "./store";
import { restoreBounds } from "./windowstate";
import { closeAction, askText, ASK_BUTTONS } from "./closeguard";
import { checkForUpdate, downloadUpdate, startupCheckEnabled, type UpdateInfo } from "./appupdate";
import { CloudManager } from "./cloud";
import { bundleExecutable } from "./macos";
import { iconSource, pickBinaryDialog } from "./hostui";
import { bootstrap, createHandlers, exportChoice, getSyncManager, importData, importFingerprint } from "./handlers";

const isDev = process.env.ELECTRON_DEV === "1";

let mainWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quittingApp = false;
/** Cloud sessions (cloud.ts); created once the app is ready. */
let cloud: CloudManager;
/** One viewer window per profile running in the cloud. */
const viewers = new Map<string, BrowserWindow>();

const MIN_W = 900;
const MIN_H = 600;

function createWindow(): void {
  // Reopen where it was — but only on a screen that still exists (windowstate.ts).
  const restored = restoreBounds(
    readSettings().window,
    screen.getAllDisplays().map((d) => d.workArea),
    { minWidth: MIN_W, minHeight: MIN_H },
  );
  const win = new BrowserWindow({
    width: restored.bounds?.width ?? 1180,
    height: restored.bounds?.height ?? 820,
    x: restored.bounds?.x,
    y: restored.bounds?.y,
    minWidth: MIN_W,
    minHeight: MIN_H,
    backgroundColor: "#07080a", // Ink
    title: "Clearcote Profile Manager",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWin = win;
  if (restored.maximized) win.maximize();

  // Remember the size and place (the normal bounds, so un-maximising lands where it was).
  const saveBounds = () => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const b = win.getNormalBounds();
    writeSettings({ ...readSettings(), window: { ...b, maximized: win.isMaximized() } });
  };
  let saveTimer: NodeJS.Timeout | null = null;
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveBounds, 600);
  };
  for (const ev of ["resize", "move", "maximize", "unmaximize"] as const) win.on(ev as "resize", saveSoon);

  // Closing with browsers open: ask, keep running in the tray, or close them and quit (closeguard.ts).
  win.on("close", (e) => {
    saveBounds();
    const cloudCount = cloud?.list().length ?? 0;
    const running = launcher.listRunning().length + cloudCount;
    const action = closeAction(running, readSettings().closeBehavior, quittingApp);
    if (action === "close") return;
    e.preventDefault();
    if (action === "tray") return hideToTray(win);
    if (action === "stop-and-quit") return void stopAndQuit();
    const q = askText(running, cloudCount);
    void dialog
      .showMessageBox(win, {
        type: "question",
        buttons: [...ASK_BUTTONS],
        defaultId: 0,
        cancelId: 2,
        title: "Browsers are still running",
        message: q.message,
        detail: q.detail,
        checkboxLabel: "Remember my choice (Settings → General changes it)",
      })
      .then(({ response, checkboxChecked }) => {
        if (response === 2) return;
        if (checkboxChecked) writeSettings({ ...readSettings(), closeBehavior: response === 0 ? "tray" : "quit" });
        if (response === 0) hideToTray(win);
        else void stopAndQuit();
      });
  });
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
  });

  // The renderer arms `beforeunload` while the profile editor holds unsaved changes. Electron never
  // shows a prompt for it on its own — the close would just silently not happen — so ask here.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Keep editing", "Discard and close"],
      defaultId: 0,
      cancelId: 0,
      title: "Unsaved changes",
      message: "A profile has unsaved changes.",
      detail: "Close anyway and lose them?",
    });
    if (choice === 1) e.preventDefault(); // preventDefault here means: ignore beforeunload, close
  });

  if (isDev) {
    win.loadURL("http://localhost:3000");
  } else {
    win.loadFile(path.join(__dirname, "..", "out", "index.html"));
  }
}

function showWindow(): void {
  if (!mainWin || mainWin.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
  tray?.destroy(); // the tray is only there while the window is hidden
  tray = null;
}

async function trayIcon(): Promise<NativeImage> {
  // The app's own icon, straight from the executable — nothing extra to package.
  return app.getFileIcon(iconSource(process.execPath), { size: "small" });
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const byId = new Map(profiles.listProfiles().map((p) => [p.id, p.name?.trim() || p.id]));
  const runningIds = launcher.listRunning();
  const inCloud = cloud?.list() ?? [];
  const total = runningIds.length + inCloud.length;
  tray.setToolTip(
    total === 1 ? "Clearcote Profile Manager — 1 browser running" : `Clearcote Profile Manager — ${total} browsers running`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Clearcote Profile Manager", click: showWindow },
      { type: "separator" },
      ...runningIds.map((id) => ({
        label: `Stop “${byId.get(id) ?? id}”`,
        click: () => void launcher.stop(id).then(refreshTrayMenu),
      })),
      ...inCloud.map((c) => ({
        label: `Stop “${byId.get(c.profileId) ?? c.name}” (cloud)`,
        click: () => void cloud.stop(c.profileId).then(refreshTrayMenu),
      })),
      ...(total ? [{ type: "separator" as const }] : []),
      { label: total ? "Close browsers and quit" : "Quit", click: () => void stopAndQuit() },
    ]),
  );
}

function hideToTray(win: BrowserWindow): void {
  void trayIcon().then((icon) => {
    if (!tray) {
      tray = new Tray(icon);
      tray.on("click", showWindow);
      if (process.platform === "win32") {
        tray.displayBalloon({
          title: "Still running",
          content: "Your browsers keep running. The app is in the tray — click it to open it again.",
        });
      }
    }
    refreshTrayMenu();
    win.hide();
  });
}

/** Close every browser gracefully (each licence slot checked back in, each cloud browser stopped), then quit. */
async function stopAndQuit(): Promise<void> {
  if (quittingApp) return;
  quittingApp = true;
  launcher.setQuitting(true);
  await getSyncManager({ cloud: () => cloud }).shutdown();
  await Promise.all([
    launcher.stopAll({ timeoutMs: 8000 }),
    // Bounded: an unreachable API must not keep the app from quitting.
    Promise.race([cloud?.stopAll().catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]),
  ]);
  tray?.destroy();
  tray = null;
  app.quit();
}

function sendAll(channel: string, data: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
}

/**
 * The window that shows a profile's cloud browser and takes its input: one per profile, brought
 * forward when it is already open. It loads the app's own /cloud page with the same narrow preload;
 * it may not navigate anywhere else or open windows of its own.
 */
function openViewer(profileId: string): boolean {
  const s = cloud.get(profileId);
  if (!s) return false;
  const open = viewers.get(profileId);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    return true;
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#07080a",
    title: `${s.name} — Cloud`,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  viewers.set(profileId, win);
  // The window keeps the profile's name; the page's own <title> is the app's.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.on("closed", () => {
    if (viewers.get(profileId) === win) viewers.delete(profileId);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  if (isDev) void win.loadURL(`http://localhost:3000/cloud?id=${encodeURIComponent(profileId)}`);
  else void win.loadFile(path.join(__dirname, "..", "out", "cloud.html"), { query: { id: profileId } });
  return true;
}


function registerIpc(): void {
  // Everything that needs no window or dialog is shared with the helper (handlers.ts).
  const handlers = createHandlers({
    cloud: () => cloud,
    changed: refreshTrayMenu,
    openViewer,
    openPath: (dir) => shell.openPath(dir),
    openExternal: (url) => void shell.openExternal(url),
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (e, ...args) =>
      fn({ emit: (ch, data) => void (!e.sender.isDestroyed() && e.sender.send(ch, data)) }, ...args),
    );
  }

  ipcMain.handle("pickBinary", async () => {
    // The Linux binary is a bare `chrome` with no extension, and an "exe"-only filter would hide
    // the very file being asked for — so the filter follows the host, and Linux keeps an
    // all-files fallback rather than trusting an extensionless match. On macOS the browser is an app
    // bundle, which the picker hands back as the `.app` folder; it is stored as the executable inside.
    const r = await dialog.showOpenDialog(pickBinaryDialog(process.platform));
    if (r.canceled || !r.filePaths[0]) return null;
    const picked = bundleExecutable(r.filePaths[0]);
    const s = readSettings();
    s.binaryPath = picked;
    writeSettings(s);
    return picked;
  });

  // ── App updates ────────────────────────────────────────────────────────────
  // Check, tell, download-and-verify — the person runs the installer. See electron/appupdate.ts
  // for why this is not electron-updater.
  // Asked once per app start by the renderer, unless the person turned it off in Settings; the
  // Settings "Check now" button forces it. There is deliberately no remembered per-version skip any
  // more: the suggestion comes back on every start, and the Settings switch is the one remembered
  // way to stop it (see appupdate.ts startupCheckEnabled).
  ipcMain.handle("update:check", async (_e, force?: boolean) => {
    if (!force && !startupCheckEnabled(readSettings())) return null;
    const info = await checkForUpdate(app.getVersion());
    writeSettings({ ...readSettings(), lastUpdateCheck: new Date().toISOString() });
    return info;
  });

  ipcMain.handle("update:download", async (e, info: UpdateInfo) =>
    downloadUpdate(info, (pct, seenMB, totalMB) => {
      if (!e.sender.isDestroyed()) e.sender.send("update:progress", { pct, seenMB, totalMB });
    }),
  );

  // openPath, not spawn: the OS shell runs the installer with the user's own elevation prompt in
  // front of them, rather than this app starting an installer on their behalf.
  ipcMain.handle("update:run", async (_e, file: string) => {
    await shell.openPath(file);
  });
  ipcMain.handle("update:reveal", (_e, file: string) => shell.showItemInFolder(file));
  ipcMain.handle("update:openReleases", (_e, url: string) => shell.openExternal(url));


  ipcMain.handle("profiles:export", async (_e, opts?: { includeSecrets?: boolean; ids?: string[] }) => {
    // `ids` exports just those profiles (a card's "Export…"); omitted, everything.
    const x = exportChoice(opts);
    if (x.chosen.length === 0) return { ok: false };
    const r = await dialog.showSaveDialog({
      title: x.title,
      defaultPath: x.filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    // Secrets are left out unless the person ticked "include" — see profiles.ts exportList.
    const list = x.list();
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
      return importData(JSON.parse(fs.readFileSync(r.filePaths[0], "utf8")));
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
      return importFingerprint(r.filePaths[0], fs.readFileSync(r.filePaths[0], "utf8"));
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
}

// One copy of the app at a time. Two copies each showed the update banner and raced the same
// download, and each keeps its own running-browser / lease bookkeeping, so a profile could be
// launched twice. A second start just brings the existing window forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow()); // also brings it back from the tray
}

app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  cloud = bootstrap(path.join(app.getPath("userData"), "cloud-sessions.json"));
  cloud.on("changed", (list) => {
    sendAll("cloud:changed", list);
    refreshTrayMenu();
  });
  cloud.on("ended", (ev) => sendAll("cloud:ended", ev));
  registerIpc();
  getSyncManager({ cloud: () => cloud }).on("changed", (runs) => sendAll("sync:changed", runs));
  // A browser that stopped without being asked to: tell the window, so its card can say why.
  launcher.browserEvents.on("exited", (ev) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("browser:exited", ev);
    refreshTrayMenu();
  });
  // Quitting from anywhere else (the OS, a menu) closes the browsers properly first.
  app.on("before-quit", (e) => {
    if (quittingApp || (launcher.listRunning().length === 0 && cloud.list().length === 0)) return;
    e.preventDefault();
    void stopAndQuit();
  });
  createWindow();
  // Cloud browsers this app started before a restart keep running on the servers: pick them back up.
  void cloud.restore();
  // macOS: the Dock icon brings the window back — also when it was hidden to the menu bar with
  // browsers running, which leaves the app with a window, just not a visible one.
  app.on("activate", () => showWindow());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
