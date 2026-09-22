import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, screen, type NativeImage } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import * as geo from "./geo";
import { readSettings, writeSettings, ensureDirs, FINGERPRINTS_DIR, PROFILES_DIR } from "./store";
import { checkLicense, resolveLicenseKey } from "./license";
import { fetchCatalog, listVersions, fetchProRevisions } from "./catalog";
import { screenWarningFromLabel } from "./fpargs";
import { summarizeFingerprint } from "./fpmeta";
import { listCached, removeCached, listTempCopies, cleanTempCopies, purgeDeleting } from "./cache";
import { storagePlan, pruneBuilds } from "./storage";
import { restoreBounds } from "./windowstate";
import { closeAction, askText, ASK_BUTTONS } from "./closeguard";
import { redactProxyString } from "./proxy";
import { checkForUpdate, downloadUpdate, startupCheckEnabled, type UpdateInfo } from "./appupdate";
import { launchTarget, resetLaunchTargetCache } from "./launchTarget";
import { mergeRendererSettings } from "./settingsmerge";
import type { Profile, Settings, FingerprintMeta } from "./types";

const CLEARCOTE_PROFILES_REPO = "clearcotelabs/clearcote-profiles";

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

let mainWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quittingApp = false;

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
    const running = launcher.listRunning().length;
    const action = closeAction(running, readSettings().closeBehavior, quittingApp);
    if (action === "close") return;
    e.preventDefault();
    if (action === "tray") return hideToTray(win);
    if (action === "stop-and-quit") return void stopAndQuit();
    const q = askText(running);
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
  return app.getFileIcon(process.execPath, { size: "small" });
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const byId = new Map(profiles.listProfiles().map((p) => [p.id, p.name?.trim() || p.id]));
  const runningIds = launcher.listRunning();
  tray.setToolTip(
    runningIds.length === 1 ? "Clearcote Profile Manager — 1 browser running" : `Clearcote Profile Manager — ${runningIds.length} browsers running`,
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Clearcote Profile Manager", click: showWindow },
      { type: "separator" },
      ...runningIds.map((id) => ({
        label: `Stop “${byId.get(id) ?? id}”`,
        click: () => void launcher.stop(id).then(refreshTrayMenu),
      })),
      ...(runningIds.length ? [{ type: "separator" as const }] : []),
      { label: runningIds.length ? "Close browsers and quit" : "Quit", click: () => void stopAndQuit() },
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

/** Close every browser gracefully (each licence slot checked back in), then quit. */
async function stopAndQuit(): Promise<void> {
  if (quittingApp) return;
  quittingApp = true;
  launcher.setQuitting(true);
  await launcher.stopAll({ timeoutMs: 8000 });
  tray?.destroy();
  tray = null;
  app.quit();
}

/** Remove builds nothing needs any more, after a download brought a newer one. */
function autoPruneSoon(): void {
  if (readSettings().autoPruneBuilds === false) return;
  // After the launch settles: the new build is running by then, so it is kept either way.
  setTimeout(() => void pruneBuilds(readSettings()).catch(() => {}), 3000);
}

const ALLOWED_EXTERNAL = [/^https:\/\/www\.clearcotelabs\.com\//, /^https:\/\/github\.com\/clearcotelabs\//];

function registerIpc(): void {
  ipcMain.handle("profiles:list", () => profiles.listProfiles());
  ipcMain.handle("profiles:get", (_e, id: string) => profiles.getProfile(id));
  ipcMain.handle("profiles:save", (_e, p: Profile) => profiles.saveProfile(p));

  // Delete is recoverable: the profile and its browser data move to a trash folder, the UI offers
  // Undo, and the trash is purged after profiles.TRASH_TTL_MS. A running profile is refused — its
  // browser holds the data folder open, and deleting a live identity from under it is never meant.
  ipcMain.handle("profiles:delete", (_e, id: string) => {
    if (launcher.listRunning().includes(id)) {
      return { ok: false, error: "Stop this profile's browser before deleting it." };
    }
    profiles.purgeTrash();
    return profiles.trashProfile(id);
  });
  ipcMain.handle("profiles:restore", (_e, trashId: string) => profiles.restoreProfile(trashId));
  // Open the profile's saved browser data (cookies, storage…) in Explorer / the file manager.
  ipcMain.handle("profiles:openData", async (_e, id: string) => {
    if (!profiles.isSafeId(id)) return { ok: false, error: "Invalid profile id." };
    const p = profiles.getProfile(id);
    const dir = p?.userDataDir || path.join(PROFILES_DIR, id, "userdata");
    if (!fs.existsSync(dir)) return { ok: false, error: "No browser data yet — it is created on the first launch." };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // What a profile on "Latest" launches right now — the header pill.
  ipcMain.handle("launchTarget", () => launchTarget(readSettings()));

  // Launch, streaming browser-download progress back to the renderer (first use of a version
  // downloads 100–250 MB — the UI shows a live bar so it never looks frozen).
  ipcMain.handle("launch", async (e, p: Profile) => {
    let downloaded = false;
    const r = await launcher.launch(p, (prog) => {
      downloaded = true;
      if (!e.sender.isDestroyed()) e.sender.send("download:progress", prog);
    });
    if (downloaded) autoPruneSoon();
    refreshTrayMenu();
    return r;
  });
  // Graceful: the browser closes like its own window would, and the call returns once its licence
  // slot is checked back in (procstop.ts).
  ipcMain.handle("stop", async (_e, id: string) => {
    const outcome = await launcher.stop(id);
    refreshTrayMenu();
    return outcome;
  });
  ipcMain.handle("running", () => launcher.listRunning());

  // Public browser-build catalog (drives the per-profile version dropdown). Best-effort: an
  // unreachable catalog returns [] so the UI just falls back to "latest".
  ipcMain.handle("versions:list", async () => {
    try {
      return listVersions(await fetchCatalog(readSettings().licenseApiBase));
    } catch {
      return [];
    }
  });

  // PRO rebuild revisions ("150.0.7871.114-r10", …), newest first, for the version dropdown.
  // "latest" and a bare major track the CURRENT pin, which moves when a rebuild ships — pinning a
  // revision is what makes a run reproducible. Best-effort: [] when unlicensed or unreachable.
  ipcMain.handle("versions:revisions", async () => {
    const s = readSettings();
    return fetchProRevisions(resolveLicenseKey(s.licenseKey), s.licenseApiBase);
  });

  // Downloaded-browser cache: view what's on disk + remove a build to force a re-download.
  ipcMain.handle("cache:list", () => listCached());
  ipcMain.handle("cache:remove", (_e, tag: string) => removeCached(tag));

  // Settings → Storage. What can go and why the rest stays (cacheplan.ts), removing it, the
  // browser copies outside the cache, each profile's own data, and fetching the build ahead of time.
  ipcMain.handle("storage:plan", async () => {
    const plan = await storagePlan(readSettings());
    const view = (b: { tag: string; version: string; tier: string; sizeBytes: number }) => ({
      tag: b.tag,
      version: b.version,
      tier: b.tier,
      sizeBytes: b.sizeBytes,
    });
    return {
      keep: plan.keep.map((k) => ({ ...view(k.build), reasons: k.reasons })),
      remove: plan.remove.map(view),
      freeBytes: plan.freeBytes,
      offline: plan.offline,
    };
  });
  ipcMain.handle("storage:prune", () => pruneBuilds(readSettings()));
  ipcMain.handle("storage:temp", () => listTempCopies());
  ipcMain.handle("storage:cleanTemp", () => cleanTempCopies());
  ipcMain.handle("storage:profileSizes", async () => {
    const run = new Set(launcher.listRunning());
    return Promise.all(
      profiles.listProfiles().map(async (p) => ({
        id: p.id,
        name: p.name?.trim() || p.id,
        bytes: await profiles.dirSizeAsync(profiles.userDataDirOf(p)),
        running: run.has(p.id),
      })),
    );
  });
  ipcMain.handle("profiles:clearCache", async (_e, id: string) => {
    if (!profiles.isSafeId(id)) return { ok: false, error: "Invalid profile id." };
    if (launcher.listRunning().includes(id)) return { ok: false, error: "Stop this profile's browser first — it has its cache open." };
    const p = profiles.getProfile(id);
    if (!p) return { ok: false, error: "That profile no longer exists." };
    return { ok: true, freedBytes: await profiles.clearBrowsingCache(profiles.userDataDirOf(p)) };
  });
  ipcMain.handle("build:prefetch", async (e) => {
    let downloaded = false;
    try {
      const r = await launcher.ensureBuild(undefined, readSettings(), (pct, seenMB, totalMB, version) => {
        downloaded = true;
        if (!e.sender.isDestroyed()) e.sender.send("prefetch:progress", { pct, seenMB, totalMB, version });
      });
      if (downloaded) autoPruneSoon();
      resetLaunchTargetCache();
      return { ok: true, version: r.version, major: r.major, downloaded };
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message || err) };
    }
  });

  ipcMain.handle("profiles:renameGroup", (_e, from: string, to: string) => profiles.renameGroup(String(from), String(to)));

  // Look up where a profile's proxy exits, and keep the answer on the profile for its card.
  ipcMain.handle("geo:checkProfile", async (_e, id: string) => {
    if (!profiles.isSafeId(id)) return { ok: false, error: "Invalid profile id." };
    const p = profiles.getProfile(id);
    if (!p) return { ok: false, error: "That profile no longer exists." };
    const g = await geo.geoCheck(p);
    const saved = profiles.recordGeo(id, g, p.proxy);
    return g.ok ? { ...g, profile: saved ?? undefined } : g;
  });

  // Links out of the app go only to our own pages.
  ipcMain.handle("openExternal", (_e, url: string) => {
    if (!ALLOWED_EXTERNAL.some((re) => re.test(String(url)))) return false;
    void shell.openExternal(url);
    return true;
  });

  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => {
    // lastPlan belongs to the main process, never to the renderer's copy — see settingsmerge.ts.
    const { next, licenceChanged } = mergeRendererSettings(readSettings(), s);
    if (licenceChanged) resetLaunchTargetCache();
    writeSettings(next);
    return readSettings();
  });

  ipcMain.handle("license:check", async (_e, key?: string) => {
    const s = readSettings();
    const status = await checkLicense(key ?? s.licenseKey, s.licenseApiBase);
    // Only when the checked key IS the saved one — a key typed but not saved says nothing about it.
    if (status.ok && status.plan && (key ?? s.licenseKey) === readSettings().licenseKey) {
      writeSettings({ ...readSettings(), lastPlan: status.plan });
    }
    return status;
  });

  ipcMain.handle("resolveBinary", () => launcher.resolveBinary());
  ipcMain.handle("pickBinary", async () => {
    // The Linux binary is a bare `chrome` with no extension, and an "exe"-only filter would hide
    // the very file being asked for — so the filter follows the host, and Linux keeps an
    // all-files fallback rather than trusting an extensionless match.
    const win = process.platform === "win32";
    const r = await dialog.showOpenDialog({
      title: win ? "Select the Clearcote chrome.exe" : "Select the Clearcote chrome binary",
      properties: ["openFile"],
      filters: win
        ? [{ name: "Clearcote browser", extensions: ["exe"] }]
        : [{ name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = readSettings();
    s.binaryPath = r.filePaths[0];
    writeSettings(s);
    return r.filePaths[0];
  });

  ipcMain.handle("geo:check", (_e, p: Profile) => geo.geoCheck(p));

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
    const only = opts?.ids?.length ? new Set(opts.ids) : null;
    const chosen = profiles.listProfiles().filter((p) => !only || only.has(p.id));
    if (chosen.length === 0) return { ok: false };
    const r = await dialog.showSaveDialog({
      title: chosen.length === 1 && only ? `Export “${chosen[0].name || chosen[0].id}”` : "Export profiles",
      defaultPath: chosen.length === 1 && only ? `${chosen[0].id}.json` : "clearcote-profiles.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    // Secrets are left out unless the person ticked "include" — see profiles.ts exportList.
    const list = profiles.exportList(chosen, { includeSecrets: !!opts?.includeSecrets });
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
      // Never overwrites: a taken or unsafe id gets a fresh one (profiles.ts importProfiles).
      const { count, renamed } = profiles.importProfiles(Array.isArray(data) ? data : [data]);
      return { ok: true, count, renamed };
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
    const RAW = `https://raw.githubusercontent.com/${CLEARCOTE_PROFILES_REPO}/main/samples`;
    // Prefer the curated index.json: it tags each profile with GPU vendor/family/renderer/screen so
    // the user can pick one matching their host GPU (keeps the imported GPU coherent with the render).
    try {
      const ir = await fetch(`${RAW}/index.json`, {
        headers: { "User-Agent": "clearcote-profile-manager" },
      });
      if (ir.ok) {
        const idx = (await ir.json()) as { profiles?: Array<Record<string, unknown>> };
        if (Array.isArray(idx.profiles) && idx.profiles.length) {
          const list = idx.profiles.map((e) => ({
            name: `${e.id}.json`,
            downloadUrl: `${RAW}/${e.id}.json`,
            gpuVendor: e.gpu_vendor as string | undefined,
            gpuFamily: e.gpu_family as string | undefined,
            renderer: e.renderer as string | undefined,
            screen: e.screen as string | undefined,
            // The index's screen is "WxH" — check it so the picker can warn about a capture too
            // small to contain a real window BEFORE the user downloads and adopts it.
            screenWarning: screenWarningFromLabel(e.screen as string | undefined) ?? undefined,
          }));
          return { ok: true, profiles: list };
        }
      }
    } catch {
      /* fall through to the directory listing */
    }
    // Fallback: list the samples/ directory (older repo state without index.json).
    try {
      const res = await fetch(
        `https://api.github.com/repos/${CLEARCOTE_PROFILES_REPO}/contents/samples`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "clearcote-profile-manager" } },
      );
      if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
      const items = (await res.json()) as Array<{ name: string; download_url: string }>;
      const list = (Array.isArray(items) ? items : [])
        .filter((it) => typeof it.name === "string" && it.name.endsWith(".json") && it.name !== "index.json")
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
  ensureDirs();
  profiles.purgeTrash(); // deletes past their undo window, from this run or an earlier one
  void purgeDeleting(); // a cache removal interrupted between rename and delete
  registerIpc();
  // A browser that stopped without being asked to: tell the window, so its card can say why.
  launcher.browserEvents.on("exited", (ev) => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send("browser:exited", ev);
    refreshTrayMenu();
  });
  // Quitting from anywhere else (the OS, a menu) closes the browsers properly first.
  app.on("before-quit", (e) => {
    if (quittingApp || launcher.listRunning().length === 0) return;
    e.preventDefault();
    void stopAndQuit();
  });
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
