// The app's request handlers, shared by the two front doors: the desktop app's IPC (main.ts) and the
// helper's localhost API for the web version (helper/server.ts). Nothing here touches Electron, so
// the helper runs it on plain Node. What needs a window or a native dialog stays in main.ts; the
// web version gets dialog-free twins (profiles:exportData, profiles:importData, fp:importData).

import path from "node:path";
import fs from "node:fs";
import * as profiles from "./profiles";
import * as launcher from "./launcher";
import * as geo from "./geo";
import { checkProxy, resolveExit } from "./proxycheck";
import { webrtcIpFollowsProxy } from "./proxyargs";
import { readSettings, writeSettings, ensureDirs, FINGERPRINTS_DIR, PROFILES_DIR, ROOT } from "./store";
import { apiBase, checkLicense, resolveLicenseKey } from "./license";
import { pollLogin, startLogin } from "./devicelogin";
import { fetchCatalog, listVersions, fetchProRevisions } from "./catalog";
import { screenWarningFromLabel } from "./fpargs";
import { summarizeFingerprint } from "./fpmeta";
import { listCached, removeCached, listTempCopies, cleanTempCopies, purgeDeleting } from "./cache";
import { storagePlan, pruneBuilds } from "./storage";
import { launchTarget, resetLaunchTargetCache } from "./launchTarget";
import { mergeRendererSettings } from "./settingsmerge";
import { CloudManager } from "./cloud";
import { CloudApi, resolveApiBase, resolveApiKey } from "./cloudapi";
import { attachOnce } from "./cdpattach";
import { hostGpuCached } from "./hostgpu";
import { parseCookies, parseMigration } from "./migrate";
import { addPending, readPending } from "./cookiejar";
import crypto from "node:crypto";
import { SyncManager, spawnJet, type StartRequest, type SyncRun } from "./jetsync";
import { deleteTask, readTasks, recordRun, saveTask, tasksPath, type SavedTask } from "./tasks";
import { getTaskSkill, resetTaskSkill, saveTaskSkill, type EditStep } from "./taskskill";
import * as ext from "./extensions";
import { checkKey, findPython, installJet, isCustomCommand, jetStatus, type JetStatus } from "./jetsetup";
import type { Profile, Settings, FingerprintMeta } from "./types";

const CLEARCOTE_PROFILES_REPO = "clearcotelabs/clearcote-profiles";

/** Links out of the app go only to our own pages. */
export const ALLOWED_EXTERNAL = [
  /^https:\/\/www\.clearcotelabs\.com\//,
  /^https:\/\/github\.com\/clearcotelabs\//,
  // Jet setup (electron/jetsetup.ts): where to get Python and the model key.
  /^https:\/\/www\.python\.org\/downloads\/$/,
  /^https:\/\/console\.typesafe\.ai\/?$/,
];

/** Who asked: lets a handler stream progress back to that caller. */
export interface HandlerCtx {
  emit(channel: string, data: unknown): void;
}

/** What a handler needs from the front door it runs behind. */
export interface HandlerHost {
  cloud(): CloudManager;
  /** Something started or stopped (the desktop app refreshes its tray menu). */
  changed(): void;
  /** Show a cloud profile's viewer. The web version opens it in a tab itself, so the helper says false. */
  openViewer(id: string): boolean;
  /** Open a folder in the file manager; resolves to "" or an error message. */
  openPath(dir: string): Promise<string>;
  openExternal(url: string): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (ctx: HandlerCtx, ...args: any[]) => unknown;

/** Persist a captured-profile JSON into the shared fingerprints dir; returns its filename + meta. */
export function storeFingerprint(name: string, json: string, source: "file" | "library") {
  fs.mkdirSync(FINGERPRINTS_DIR, { recursive: true });
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.json$/i, "");
  const file = `${base}.json`;
  fs.writeFileSync(path.join(FINGERPRINTS_DIR, file), json, "utf8");
  const sum = summarizeFingerprint(JSON.parse(json));
  return { file, meta: { ...(sum.meta || {}), source } as FingerprintMeta };
}

/** A captured-profile JSON checked and stored, or why not. */
export function importFingerprint(name: string, json: string) {
  try {
    if (!summarizeFingerprint(JSON.parse(json)).ok)
      return { ok: false, error: "Not a clearcote-profile (missing webgl/screen/hardware fields)." };
    const { file, meta } = storeFingerprint(path.basename(String(name)), json, "file");
    return { ok: true, file, meta };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** The profiles to export (all, or just `ids`), secrets left out unless asked for. */
export function exportChoice(opts?: { includeSecrets?: boolean; ids?: string[] }) {
  const only = opts?.ids?.length ? new Set(opts.ids) : null;
  const chosen = profiles.listProfiles().filter((p) => !only || only.has(p.id));
  const single = chosen.length === 1 && !!only;
  return {
    chosen,
    title: single ? `Export “${chosen[0].name || chosen[0].id}”` : "Export profiles",
    filename: single ? `${chosen[0].id}.json` : "clearcote-profiles.json",
    list: () => profiles.exportList(chosen, { includeSecrets: !!opts?.includeSecrets }),
  };
}

/** Import parsed profile JSON. Never overwrites: a taken or unsafe id gets a fresh one. */
export function importData(data: unknown) {
  try {
    const { count, renamed } = profiles.importProfiles(Array.isArray(data) ? data : [data]);
    return { ok: true, count, renamed };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Profiles from another browser's export (electron/migrate.ts): each gets a fresh id and seed, the new-profile
 * defaults (src/lib/newProfile.ts: geoip and Widevine on) and its cookies parked for the first launch.
 */
export function migrateImport(text: string, filename?: string) {
  try {
    const parsed = parseMigration(String(text ?? ""), String(filename ?? ""));
    const now = new Date().toISOString();
    const fallback = process.platform === "darwin" ? "macos" : "windows";
    for (const m of parsed.profiles) {
      const id = profiles.freshId(m.name);
      profiles.saveProfile({
        id,
        name: m.name,
        fingerprint: crypto.randomBytes(6).toString("hex"),
        platform: m.platform ?? fallback,
        geoip: true,
        widevine: true,
        ...(m.notes ? { notes: m.notes } : {}),
        ...(m.tags ? { tags: m.tags } : {}),
        ...(m.group ? { group: m.group } : {}),
        ...(m.proxy ? { proxy: m.proxy } : {}),
        createdAt: now,
        updatedAt: now,
      });
      if (m.cookies.length) addPending(id, m.cookies);
    }
    return { ok: true, count: parsed.profiles.length, cookies: parsed.cookies, skipped: parsed.skipped, warnings: parsed.warnings };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/** Cookies from a file or pasted text, added to a saved profile for its next launch. */
export function importCookies(id: string, text: string) {
  if (!profiles.isSafeId(String(id)) || !profiles.getProfile(String(id))) return { ok: false, error: "Save the profile first." };
  const jar = parseCookies(String(text ?? ""));
  if (!jar.cookies.length) {
    return {
      ok: false,
      error: jar.expired
        ? `All ${jar.expired} cookies in it have expired.`
        : "No cookies found. Use a cookies.txt file or the JSON an extension like Cookie-Editor exports.",
    };
  }
  const pending = addPending(String(id), jar.cookies);
  return { ok: true, count: jar.cookies.length, expired: jar.expired, skipped: jar.skipped, pending };
}

/** Remove builds nothing needs any more, after a download brought a newer one. */
function autoPruneSoon(): void {
  if (readSettings().autoPruneBuilds === false) return;
  // After the launch settles: the new build is running by then, so it is kept either way.
  setTimeout(() => void pruneBuilds(readSettings()).catch(() => {}), 3000);
}

/** A cloud API client for the saved settings (or a key typed into Settings), or why there is none. */
export function cloudClient(key?: string): CloudApi | { error: string; code: string } {
  const s = readSettings();
  const apiKey = resolveApiKey(key ?? s.cloudApiKey);
  if (!apiKey) return { error: "Add your Clearcote API key in Settings → Cloud to run profiles in the cloud.", code: "NO_KEY" };
  const base = resolveApiBase(s.cloudApiBase);
  if (!base.ok) return { error: base.error, code: "BAD_BASE" };
  return new CloudApi({ apiKey, base: base.base });
}

/** Start-up shared by both front doors: folders, trash, interrupted removals, the geoip database,
 *  and the cloud session follower (persisted in `cloudFile`). */
export function bootstrap(cloudFile: string): CloudManager {
  ensureDirs();
  profiles.purgeTrash(); // deletes past their undo window, from this run or an earlier one
  void purgeDeleting(); // a cache removal interrupted between rename and delete
  // A profile that resolves its region from the proxy needs the offline geoip database: fetch it now
  // (once, ~52 MB, shared with the SDKs) rather than inside that profile's first launch.
  if (profiles.listProfiles().some((p) => p.geoip && p.proxy)) geo.prefetchGeoDb();
  return new CloudManager({
    api: () => cloudClient(),
    attach: (url) => attachOnce(url),
    file: cloudFile,
    runningLocally: (id) => launcher.listRunning().includes(id),
    pollMs: Number(process.env.CLEARCOTE_CLOUD_POLL_MS) || 15_000,
  });
}

const TASKS_FILE = () => tasksPath(ROOT);

/** A saved task by id, or the error the editor shows. */
async function withTask<T>(id: string, fn: (t: SavedTask) => Promise<T>): Promise<T | { ok: false; error: string }> {
  const task = readTasks(TASKS_FILE()).find((x) => x.id === String(id));
  return task ? fn(task) : { ok: false, error: "That task is no longer saved." };
}

/** An extension call as { ok, extension } or { ok: false, error } — the UI shows the error as it is. */
export async function wrapExt(fn: () => Promise<ext.ExtensionEntry>): Promise<{ ok: true; extension: ext.ExtensionEntry } | { ok: false; error: string }> {
  try {
    return { ok: true, extension: await fn() };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

/** The one task runner of this process (electron/jetsync.ts). The front door subscribes to its "changed". */
let syncManager: SyncManager | null = null;
export function getSyncManager(host: Pick<HandlerHost, "cloud">): SyncManager {
  syncManager ??= new SyncManager({
    getProfile: (id) => profiles.getProfile(id),
    // A task needs the window's DevTools endpoint, so its launches always have automation on.
    launch: (p) => launcher.launch(p, undefined, { automation: true }),
    stop: (id) => launcher.stop(id),
    isRunning: (id) => launcher.listRunning().includes(id),
    cdpEndpoint: (id) => launcher.cdpEndpoint(id),
    inCloud: (id) => host.cloud().has(id),
    settings: () => readSettings(),
    spawnWorker: spawnJet,
  });
  if (!recording) {
    recording = true;
    recordTaskRuns(syncManager);
  }
  return syncManager;
}

let recording = false;
function recordTaskRuns(manager: SyncManager): void {
  // A run of a saved task goes into its history; the first profile that finished gives the step timeline.
  manager.on("finished", (run: SyncRun) => {
    if (!run.taskId) return;
    try {
      recordFinished(run);
    } catch (e) {
      console.error(`[tasks] could not record run ${run.id} into task ${run.taskId}:`, e);
    }
    manager.emit("tasksChanged");
  });
}

function recordFinished(run: SyncRun): void {
  if (!run.taskId) return;
  {
    const done = run.rows.filter((r) => r.status === "done");
    const learned = done.find((r) => r.skill === "learned" || r.skill === "repaired");
    const best = learned ?? done[0];
    recordRun(
      TASKS_FILE(),
      run.taskId,
      { at: run.createdAt, total: run.rows.length, done: done.length, ...(run.params ? { params: run.params } : {}), usd: run.rows.reduce((a, r) => a + (r.usd ?? 0), 0) || undefined },
      best ? { steps: best.steps, from: best.name, onlyIfNone: !learned } : undefined,
    );
  }
}

/** One pip install at a time: a second click joins the one running (two into one site-packages can break it). */
let installing: Promise<{ ok: true; status: JetStatus } | { ok: false; error: string }> | null = null;
async function installOnce(): Promise<{ ok: true; status: JetStatus } | { ok: false; error: string }> {
  const py = await findPython();
  if (!py) return { ok: false, error: "No Python 3.10 or newer was found on this PC." };
  const r = await installJet(py);
  return r.ok ? { ok: true, status: await jetStatusSaved() } : r;
}

/** The setup checklist; a Jet command that works where the saved one does not is saved, unless it was typed in. */
async function jetStatusSaved(): Promise<JetStatus> {
  const s = readSettings();
  const status = await jetStatus(s, { fallback: !isCustomCommand(s.jetCommand) });
  if (status.fixedCommand && status.fixedCommand !== s.jetCommand) {
    writeSettings({ ...readSettings(), jetCommand: status.fixedCommand });
  }
  return status;
}

export function createHandlers(host: HandlerHost): Record<string, Handler> {
  const cloud = () => host.cloud();
  const sync = () => getSyncManager(host);
  return {
    "profiles:list": () => profiles.listProfiles(),
    "profiles:get": (_c, id: string) => profiles.getProfile(id),
    "profiles:save": (_c, p: Profile) => profiles.saveProfile(p),

    // Delete is recoverable: the profile and its browser data move to a trash folder, the UI offers
    // Undo, and the trash is purged after profiles.TRASH_TTL_MS. A running profile is refused — its
    // browser holds the data folder open, and deleting a live identity from under it is never meant.
    "profiles:delete": (_c, id: string) => {
      if (launcher.listRunning().includes(id)) {
        return { ok: false, error: "Stop this profile's browser before deleting it." };
      }
      if (cloud().has(id)) return { ok: false, error: "Stop this profile's cloud browser before deleting it." };
      if (sync().busyProfiles().has(id)) return { ok: false, error: "A task is running on this profile. Stop it before deleting the profile." };
      profiles.purgeTrash();
      return profiles.trashProfile(id);
    },
    "profiles:restore": (_c, trashId: string) => profiles.restoreProfile(trashId),
    // Open the profile's saved browser data (cookies, storage…) in Explorer / the file manager.
    "profiles:openData": async (_c, id: string) => {
      if (!profiles.isSafeId(id)) return { ok: false, error: "Invalid profile id." };
      const p = profiles.getProfile(id);
      const dir = p?.userDataDir || path.join(PROFILES_DIR, id, "userdata");
      if (!fs.existsSync(dir)) return { ok: false, error: "No browser data yet — it is created on the first launch." };
      const err = await host.openPath(dir);
      return err ? { ok: false, error: err } : { ok: true };
    },

    // What a profile on "Latest" launches right now — the header pill.
    launchTarget: () => launchTarget(readSettings()),

    // Launch, streaming browser-download progress back to the caller (first use of a version
    // downloads 100–250 MB — the UI shows a live bar so it never looks frozen).
    launch: async (c, p: Profile) => {
      if (cloud().has(p.id)) {
        return {
          ok: false,
          error: "This profile is running in the cloud. Stop it there first: a profile runs in one place at a time.",
          code: "RUNNING_IN_CLOUD",
        };
      }
      let downloaded = false;
      const r = await launcher.launch(p, (prog) => {
        downloaded = true;
        c.emit("download:progress", prog);
      });
      if (downloaded) autoPruneSoon();
      host.changed();
      return r;
    },
    // Graceful: the browser closes like its own window would, and the call returns once its licence
    // slot is checked back in (procstop.ts).
    stop: async (_c, id: string) => {
      const outcome = await launcher.stop(id);
      host.changed();
      return outcome;
    },
    running: () => launcher.listRunning(),

    // ── Run a task on profiles (Jet) ─────────────────────────────────────────
    "sync:list": () => sync().list(),
    "sync:start": (_c, req: StartRequest) => sync().start(req),
    "sync:approve": (_c, runId: string, profileId?: string) => sync().approve(String(runId), profileId ? String(profileId) : undefined),
    "sync:cancel": (_c, runId: string, profileId?: string) => sync().cancel(String(runId), profileId ? String(profileId) : undefined),
    "sync:stop": (_c, runId: string, profileId?: string) => sync().stop(String(runId), profileId ? String(profileId) : undefined),
    "sync:clear": () => sync().clearFinished(),
    /** Where a running profile's DevTools endpoint is, for driving it from your own script. */
    "cdp:endpoint": (_c, id: string) => launcher.cdpEndpoint(String(id)) ?? null,
    // Saved tasks (electron/tasks.ts): the recipe, its last steps and its run history.
    "tasks:list": () => readTasks(TASKS_FILE()),
    "tasks:save": (_c, t: Partial<SavedTask>) => saveTask(TASKS_FILE(), t),
    "tasks:delete": (_c, id: string) => deleteTask(TASKS_FILE(), String(id)),
    // The steps a task replays (electron/taskskill.ts): read, saved by hand, or forgotten so Jet learns them again.
    "tasks:steps": (_c, id: string) => withTask(id, (t) => getTaskSkill(readSettings(), t)),
    "tasks:saveSteps": (_c, id: string, steps: EditStep[]) => withTask(id, (t) => saveTaskSkill(readSettings(), t, steps)),
    "tasks:resetSteps": (_c, id: string) => withTask(id, (t) => resetTaskSkill(readSettings(), t)),
    // Extensions (electron/extensions.ts): kept once on this computer, loaded into the profiles they are on.
    // Adding from a folder is the desktop app's (main.ts, with its folder picker): a web page names no paths.
    "extensions:list": () => ext.listExtensions(ROOT),
    "extensions:addStore": (_c, ref: string) => wrapExt(() => ext.addFromStore(ROOT, String(ref ?? ""))),
    "extensions:addCrxData": (_c, base64: string, fileName?: string) =>
      wrapExt(() => ext.addFromCrx(ROOT, Buffer.from(String(base64 ?? ""), "base64"), fileName ? String(fileName) : undefined)),
    "extensions:update": (_c, id: string) => wrapExt(async () => (await ext.updateExtension(ROOT, String(id))).entry),
    "extensions:checkAll": () => ext.checkAll(ROOT),
    "extensions:set": (_c, id: string, patch: { autoUpdate?: boolean }) =>
      wrapExt(async () => ext.setExtension(ROOT, String(id), { autoUpdate: patch?.autoUpdate })),
    "extensions:remove": (_c, id: string) => {
      const sid = String(id);
      if (!ext.isExtensionId(sid)) return { ok: false, error: "Not an extension ID." };
      const profilesChanged = profiles.setProfilesExtension(sid, undefined, false);
      return { ok: ext.removeExtension(ROOT, sid), profilesChanged };
    },
    /** Turn an extension on or off for these profiles; resolves to how many changed. */
    "extensions:assign": (_c, id: string, ids: string[], on: boolean) => {
      const sid = String(id);
      if (!ext.getExtension(ROOT, sid)) return 0;
      const list = Array.isArray(ids) ? ids.map(String).filter((x) => profiles.isSafeId(x)) : [];
      return profiles.setProfilesExtension(sid, list, !!on);
    },
    // Setup without a terminal (electron/jetsetup.ts): the checklist, Install Jet, and the key check.
    "jet:status": () => jetStatusSaved(),
    "jet:install": () => (installing ??= installOnce().finally(() => (installing = null))),
    "jet:checkKey": (_c, key?: string) => checkKey(typeof key === "string" && key.trim() ? key : readSettings().jetApiKey),

    // ── Cloud ────────────────────────────────────────────────────────────────
    // Run a profile on Clearcote's servers (cloud.ts), follow it, stop it, and show it in a viewer.
    // The API key stays in this process: the viewer only ever gets a 60-second view URL.
    "cloud:list": () => cloud().list(),
    "cloud:start": async (_c, p: Profile) => {
      const r = await cloud().start(p);
      if (r.ok) {
        profiles.markLaunched(p.id);
        host.openViewer(p.id);
      }
      host.changed();
      return r;
    },
    "cloud:stop": async (_c, id: string) => {
      const r = await cloud().stop(String(id));
      host.changed();
      return r;
    },
    "cloud:open": (_c, id: string) => host.openViewer(String(id)),
    "cloud:viewUrl": (_c, id: string, control?: boolean) => cloud().viewUrl(String(id), control !== false),
    // Settings → Cloud: is this key accepted, and what is the balance. A typed key is checked as typed.
    "cloud:account": async (_c, key?: string) => {
      const cl = cloudClient(typeof key === "string" && key.trim() ? key.trim() : undefined);
      if ("error" in cl) return { ok: false, error: cl.error, code: cl.code };
      const r = await cl.account();
      return r.ok ? { ok: true, balanceEur: r.data.balanceEur } : { ok: false, error: r.error, code: r.code, status: r.status };
    },

    // The GPU driving this display (hostgpu.ts) — asked once per run, then cached; "unknown" when it
    // cannot be told, in which case the editor's GPU model picker lists every vendor.
    "host:gpu": () => hostGpuCached(),

    // Public browser-build catalog (drives the per-profile version dropdown). Best-effort: an
    // unreachable catalog returns [] so the UI just falls back to "latest".
    "versions:list": async () => {
      try {
        return listVersions(await fetchCatalog(readSettings().licenseApiBase));
      } catch {
        return [];
      }
    },

    // PRO rebuild revisions ("150.0.7871.114-r10", …), newest first, for the version dropdown.
    // "latest" and a bare major track the CURRENT pin, which moves when a rebuild ships — pinning a
    // revision is what makes a run reproducible. Best-effort: [] when unlicensed or unreachable.
    "versions:revisions": async () => {
      const s = readSettings();
      return fetchProRevisions(resolveLicenseKey(s.licenseKey), s.licenseApiBase);
    },

    // Downloaded-browser cache: view what's on disk + remove a build to force a re-download.
    "cache:list": () => listCached(),
    "cache:remove": (_c, tag: string) => removeCached(tag),

    // Settings → Storage. What can go and why the rest stays (cacheplan.ts), removing it, the
    // browser copies outside the cache, each profile's own data, and fetching the build ahead of time.
    "storage:plan": async () => {
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
    },
    "storage:prune": () => pruneBuilds(readSettings()),
    "storage:temp": () => listTempCopies(),
    "storage:cleanTemp": () => cleanTempCopies(),
    "storage:profileSizes": async () => {
      const run = new Set(launcher.listRunning());
      return Promise.all(
        profiles.listProfiles().map(async (p) => {
          const dir = profiles.userDataDirOf(p);
          return {
            id: p.id,
            name: p.name?.trim() || p.id,
            bytes: await profiles.dirSizeAsync(dir),
            cacheBytes: await profiles.cacheSizeAsync(dir),
            running: run.has(p.id),
          };
        }),
      );
    },
    // One row's cache, or the cache / all browser data of the profiles ticked in the list. Same rules
    // either way (profiles.clearProfileData): a running browser is refused, the profile stays.
    "profiles:clearCache": (_c, id: string) => profiles.clearProfileData(id, "cache", launcher.listRunning()),
    "storage:clearProfiles": (_c, ids: string[], mode: profiles.ClearMode) =>
      profiles.clearProfilesData(ids, mode, launcher.listRunning()),
    "build:prefetch": async (c) => {
      let downloaded = false;
      try {
        const r = await launcher.ensureBuild(undefined, readSettings(), (pct, seenMB, totalMB, version) => {
          downloaded = true;
          c.emit("prefetch:progress", { pct, seenMB, totalMB, version });
        });
        if (downloaded) autoPruneSoon();
        resetLaunchTargetCache();
        return { ok: true, version: r.version, major: r.major, downloaded };
      } catch (err) {
        return { ok: false, error: String((err as Error)?.message || err) };
      }
    },

    "profiles:renameGroup": (_c, from: string, to: string) => profiles.renameGroup(String(from), String(to)),

    // Look up where a profile's proxy exits, and keep the answer on the profile for its card. Same
    // order as a launch (Relay UDP on → the first UDP association first). A WebRTC IP that came from
    // the previous lookup moves with this one; otherwise the new lookup would make it look typed.
    "geo:checkProfile": async (_c, id: string) => {
      if (!profiles.isSafeId(id)) return { ok: false, error: "Invalid profile id." };
      const p = profiles.getProfile(id);
      if (!p) return { ok: false, error: "That profile no longer exists." };
      const g = await resolveExit(p);
      const follow = g.ok && g.ip && webrtcIpFollowsProxy(p) ? { webrtcIp: g.ip } : undefined;
      const saved = profiles.recordGeo(id, g, p.proxy, undefined, follow);
      return g.ok ? { ...g, profile: saved ?? undefined } : g;
    },

    openExternal: (_c, url: string) => {
      if (!ALLOWED_EXTERNAL.some((re) => re.test(String(url)))) return false;
      host.openExternal(String(url));
      return true;
    },

    "settings:get": () => readSettings(),
    "settings:set": (_c, s: Settings) => {
      // lastPlan belongs to the main process, never to the renderer's copy — see settingsmerge.ts.
      const { next, licenceChanged } = mergeRendererSettings(readSettings(), s);
      if (licenceChanged) resetLaunchTargetCache();
      writeSettings(next);
      return readSettings();
    },

    "license:check": async (_c, key?: string) => {
      const s = readSettings();
      const status = await checkLicense(key ?? s.licenseKey, s.licenseApiBase);
      // Only when the checked key IS the saved one — a key typed but not saved says nothing about it.
      if (status.ok && status.plan && (key ?? s.licenseKey) === readSettings().licenseKey) {
        writeSettings({ ...readSettings(), lastPlan: status.plan });
      }
      return status;
    },

    // "Use my Clearcote account": sign in on clearcotelabs.com (devicelogin.ts). The key never leaves this
    // process: the caller gets a code to compare and an address to open, and on approval the key is saved.
    "license:loginStart": async () => {
      const r = await startLogin(apiBase(readSettings().licenseApiBase));
      return r.ok ? { ok: true, id: r.id, userCode: r.userCode, verificationUri: r.verificationUri, expiresIn: r.expiresIn, interval: r.interval } : r;
    },
    "license:loginPoll": async (_c, id: string) => {
      const r = await pollLogin(String(id));
      if (r.status !== "approved") return r;
      writeSettings({ ...readSettings(), licenseKey: r.key, ...(r.plan ? { lastPlan: r.plan } : {}) });
      resetLaunchTargetCache();
      host.changed();
      return { status: "approved", plan: r.plan, account: r.account, expiresAt: r.expiresAt };
    },

    resolveBinary: () => launcher.resolveBinary(),
    // "Resolve from proxy". With Relay UDP on, the session's first UDP association comes first, so
    // the address resolved is the one the browser will end up on (proxycheck.ts explains why).
    "geo:check": (_c, p: Profile) => resolveExit(p),
    // Reports only — the exit, the time it took and, with Relay UDP on or when asked, whether UDP gets
    // through. Writes nothing. Only `udp: true` is read from the options.
    "proxy:check": (_c, p: Profile, opts?: { udp?: unknown }) => checkProxy(p, { udp: opts?.udp === true }),

    // Dialog-free import/export for the web version: the page does the file picking and saving.
    "profiles:exportData": (_c, opts?: { includeSecrets?: boolean; ids?: string[] }) => {
      const x = exportChoice(opts);
      if (x.chosen.length === 0) return { ok: false };
      const list = x.list();
      return { ok: true, filename: x.filename, count: list.length, json: JSON.stringify(list, null, 2) };
    },
    "profiles:importData": (_c, json: string) => {
      try {
        return importData(JSON.parse(String(json)));
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    },
    "migrate:import": (_c, text: string, filename?: string) => migrateImport(text, filename),
    "cookies:import": (_c, id: string, text: string) => importCookies(id, text),
    "cookies:pending": (_c, id: string) => (profiles.isSafeId(String(id)) ? readPending(String(id)).length : 0),
    "fp:importData": (_c, name: string, json: string) => importFingerprint(String(name), String(json)),

    // ---- captured fingerprint profiles (clearcote-profiles) ----
    "fp:library": async () => {
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
              cores: typeof e.hardware_concurrency === "number" ? e.hardware_concurrency : undefined,
              memory: typeof e.device_memory === "number" ? e.device_memory : undefined,
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
    },

    "fp:use": async (_c, lib: { name: string; downloadUrl: string }) => {
      try {
        // Only the clearcote-profiles samples: the helper must not fetch arbitrary URLs for a web page.
        if (!String(lib?.downloadUrl).startsWith(`https://raw.githubusercontent.com/${CLEARCOTE_PROFILES_REPO}/`))
          return { ok: false, error: "Only profiles from the clearcote-profiles library can be used this way." };
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
    },
  };
}
