import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import * as geo from "./geo";
import { readSettings, writeSettings, ensureDirs, FINGERPRINTS_DIR } from "./store";
import { checkLicense, resolveLicenseKey } from "./license";
import { fetchCatalog, listVersions, fetchProRevisions } from "./catalog";
import { screenWarningFromLabel } from "./fpargs";
import { summarizeFingerprint } from "./fpmeta";
import { listCached, removeCached } from "./cache";
import { redactProxyString } from "./proxy";
import { checkForUpdate, downloadUpdate, CHECK_INTERVAL_MS, type UpdateInfo } from "./appupdate";
import type { Profile, Settings, FingerprintMeta } from "./types";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

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

  // Launch, streaming browser-download progress back to the renderer (first use of a version
  // downloads 100–250 MB — the UI shows a live bar so it never looks frozen).
  ipcMain.handle("launch", (e, p: Profile) =>
    launcher.launch(p, (prog) => {
      if (!e.sender.isDestroyed()) e.sender.send("download:progress", prog);
    }),
  );
  ipcMain.handle("stop", (_e, id: string) => launcher.stop(id));
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

  ipcMain.handle("settings:get", () => readSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => {
    writeSettings(s);
    return readSettings();
  });

  ipcMain.handle("license:check", (_e, key?: string) => {
    const s = readSettings();
    return checkLicense(key ?? s.licenseKey, s.licenseApiBase);
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
  ipcMain.handle("update:check", async (_e, force?: boolean) => {
    const s = readSettings();
    // Default ON: a user on an old build has no other way to learn a fix shipped.
    if (s.updateCheck === false && !force) return null;
    if (!force && s.lastUpdateCheck) {
      const age = Date.now() - Date.parse(s.lastUpdateCheck);
      if (Number.isFinite(age) && age >= 0 && age < CHECK_INTERVAL_MS) return null;
    }
    const info = await checkForUpdate(app.getVersion());
    // Record the attempt either way, so an unreachable GitHub is not retried on every launch.
    writeSettings({ ...readSettings(), lastUpdateCheck: new Date().toISOString() });
    if (!info) return null;
    // A version the user dismissed stays dismissed until something newer ships.
    if (info.available && readSettings().skippedVersion === info.latest && !force) return null;
    return info;
  });

  ipcMain.handle("update:download", async (e, info: UpdateInfo) =>
    downloadUpdate(info, (pct, seenMB, totalMB) =>
      e.sender.send("update:progress", { pct, seenMB, totalMB }),
    ),
  );

  // openPath, not spawn: the OS shell runs the installer with the user's own elevation prompt in
  // front of them, rather than this app starting an installer on their behalf.
  ipcMain.handle("update:run", async (_e, file: string) => {
    await shell.openPath(file);
  });
  ipcMain.handle("update:reveal", (_e, file: string) => shell.showItemInFolder(file));
  ipcMain.handle("update:skip", (_e, version: string) => {
    writeSettings({ ...readSettings(), skippedVersion: version });
  });
  ipcMain.handle("update:openReleases", (_e, url: string) => shell.openExternal(url));


  ipcMain.handle("profiles:export", async (_e, opts?: { redact?: boolean }) => {
    const r = await dialog.showSaveDialog({
      title: "Export profiles",
      defaultPath: "clearcote-profiles.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    // Redact every secret by default: an exported profile set is the thing people paste into a
    // ticket or share with a colleague. Proxy passwords AND the cookie encryption key — that key
    // decrypts the exported profile's whole cookie jar, so it is at least as sensitive.
    const redact = opts?.redact !== false;
    const list = profiles.listProfiles().map((p) => {
      if (!redact) return p;
      const out = { ...p };
      if (out.proxy) out.proxy = redactProxyString(out.proxy);
      if (out.encryptionKey) delete out.encryptionKey;
      return out;
    });
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
