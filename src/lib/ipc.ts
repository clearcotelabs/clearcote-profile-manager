// Renderer-side bridge to the Electron main process.
// In the desktop app, window.clearcote is injected by electron/preload.ts.
// In a plain browser (next dev / preview), fall back to a localStorage-backed mock
// so the UI is fully usable for design + testing without Electron.

import { redactProxyString, screenWarningFromLabel, type Profile } from "@/types/profile";
import type { LaunchTarget } from "@/lib/launchTarget";

export type TrashResult = { ok: true; trashId: string } | { ok: false; error: string };
export type RestoreResult = { ok: true; profile: Profile } | { ok: false; error: string };

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
  /** PRO license key (`cc_lic_...`). Set = launches use the license-gated PRO browser
   *  + a floating-concurrency slot. Empty = free mode (no backend contact). */
  licenseKey?: string;
  licenseApiBase?: string;
  /** Check GitHub for a newer release every time the app starts. On unless turned off. */
  updateCheck?: boolean;
  lastUpdateCheck?: string;
  /** No longer read — see electron/types.ts. */
  skippedVersion?: string;
  /** Plan last reported for licenseKey — written by the main process, read-only here. */
  lastPlan?: string;
}
export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
  /** Machine-readable reason, when the failing layer gave one (e.g. CONCURRENCY_LIMIT_EXCEEDED). */
  code?: string;
  /** True when the launch used the PRO (license-gated) binary + a leased run-token. */
  pro?: boolean;
  /** Non-fatal problems with an otherwise successful launch — an option that will silently do
   *  nothing (a switch the resolved build predates), or geoip failing to resolve the exit region. */
  warnings?: string[];
}
export interface LicenseStatus {
  ok: boolean;
  plan?: string;
  used?: number;
  limit?: number;
  error?: string;
  code?: string;
}
export interface GeoResult {
  ok: boolean;
  ip?: string;
  country?: string;
  countryCode?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
  acceptLanguage?: string;
  error?: string;
}
export interface ExportResult {
  ok: boolean;
  path?: string;
  count?: number;
}
export interface ImportResult {
  ok: boolean;
  count?: number;
  /** Imported under a new id because theirs was unusable or already taken (never overwritten). */
  renamed?: number;
  error?: string;
}

export interface FingerprintMeta {
  label?: string;
  renderer?: string;
  cores?: number;
  memory?: number;
  screen?: string;
  screenWidth?: number;
  screenHeight?: number;
  /** Set when the captured display is too small to contain a real browser window. */
  screenWarning?: string;
  source?: "file" | "library";
}
export interface FpImportResult {
  ok: boolean;
  file?: string;
  meta?: FingerprintMeta;
  error?: string;
}
export interface LibraryProfile {
  name: string;
  downloadUrl: string;
  /** From the curated clearcote-profiles index.json — match your host GPU vendor for coherence. */
  gpuVendor?: string;
  gpuFamily?: string;
  renderer?: string;
  screen?: string;
  /** Set when the indexed screen size is below the guard floor, so the picker can warn (or filter)
   *  BEFORE downloading a capture that would produce impossible window geometry. */
  screenWarning?: string;
}
export interface FpListResult {
  ok: boolean;
  profiles?: LibraryProfile[];
  error?: string;
}

/** One available browser build (from GET /api/v1/versions), for the version dropdown. */
export interface VersionOption {
  version: string;
  major: number;
  tier: "free" | "pro";
  tag: string;
}

/** Browser-download progress streamed during a launch (first use of a version). */
export interface DownloadProgress {
  id: string;
  version: string;
  pct: number;
  seenMB: number;
  totalMB: number;
}

/** One browser build currently downloaded in the cache (removable to force a re-download). */
export interface CachedBuild {
  tag: string;
  version: string;
  tier: "free" | "pro";
  sizeBytes: number;
  path: string;
}

export interface UpdateAsset { name: string; url: string; size: number }
export interface UpdateInfo {
  available: boolean;
  latest: string;
  current: string;
  releaseUrl: string;
  notes?: string;
  asset?: UpdateAsset;
  sumsUrl?: string;
}
export interface UpdateDownloadResult {
  ok: boolean;
  path?: string;
  error?: string;
  /** False when the release published no checksums, so nothing could be checked. "Downloaded" and
   *  "downloaded and verified" are different claims and the UI says which one it is. */
  verified?: boolean;
}

export interface ClearcoteApi {
  profiles: {
    list: () => Promise<Profile[]>;
    get: (id: string) => Promise<Profile | null>;
    save: (p: Profile) => Promise<Profile>;
    /** Moves the profile and its browser data to the trash; undo with restore(). */
    remove: (id: string) => Promise<TrashResult>;
    restore: (trashId: string) => Promise<RestoreResult>;
    /** Open the profile's saved browser data folder. */
    openData: (id: string) => Promise<{ ok: boolean; error?: string }>;
  };
  /** What a profile on "Latest" launches right now — drives the header pill. */
  launchTarget: () => Promise<LaunchTarget>;
  launch: (p: Profile) => Promise<LaunchResult>;
  stop: (id: string) => Promise<void>;
  running: () => Promise<string[]>;
  /** Public browser-build catalog for this OS (newest major first). Drives the version dropdown. */
  listVersions: () => Promise<VersionOption[]>;
  /** PRO rebuild revisions ("150.0.7871.114-r10", …), newest first — pin one for a reproducible
   *  run, since "latest" and a bare major both follow the current pin. [] without a license key. */
  listRevisions: () => Promise<string[]>;
  /** Subscribe to browser-download progress during a launch. Returns an unsubscribe fn. */
  onDownloadProgress: (cb: (p: DownloadProgress) => void) => () => void;
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  license: {
    check: (key?: string) => Promise<LicenseStatus>;
  };
  /** Downloaded-browser cache: list what's on disk, and remove a build to force a re-download. */
  cache: {
    list: () => Promise<CachedBuild[]>;
    remove: (tag: string) => Promise<boolean>;
  };
  update: {
    check: (force?: boolean) => Promise<UpdateInfo | null>;
    download: (info: UpdateInfo) => Promise<UpdateDownloadResult>;
    run: (file: string) => Promise<void>;
    reveal: (file: string) => Promise<void>;
    openReleases: (url: string) => Promise<void>;
  };
  onUpdateProgress: (cb: (p: { pct: number; seenMB: number; totalMB: number }) => void) => () => void;
  resolveBinary: () => Promise<string | null>;
  pickBinary: () => Promise<string | null>;
  geoCheck: (p: Profile) => Promise<GeoResult>;
  exportProfiles: (opts?: { redact?: boolean; ids?: string[] }) => Promise<ExportResult>;
  importProfiles: () => Promise<ImportResult>;
  fp: {
    import: () => Promise<FpImportResult>;
    library: () => Promise<FpListResult>;
    use: (lib: LibraryProfile) => Promise<FpImportResult>;
  };
}

declare global {
  interface Window {
    clearcote?: ClearcoteApi;
  }
}

const PROFILES_KEY = "clearcote.profiles.mock";
const SETTINGS_KEY = "clearcote.settings.mock";

function buildMock(): ClearcoteApi {
  const read = (): Profile[] => {
    try {
      return JSON.parse(localStorage.getItem(PROFILES_KEY) || "[]") as Profile[];
    } catch {
      return [];
    }
  };
  const write = (ps: Profile[]) => localStorage.setItem(PROFILES_KEY, JSON.stringify(ps));
  const mockTrash = new Map<string, Profile>();

  return {
    profiles: {
      list: async () =>
        read().sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")),
      get: async (id) => read().find((p) => p.id === id) || null,
      save: async (p) => {
        const now = new Date().toISOString();
        const out: Profile = { ...p, createdAt: p.createdAt || now, updatedAt: now };
        write([...read().filter((x) => x.id !== out.id), out]);
        return out;
      },
      // Same trash semantics as the desktop app, so Undo works in the browser preview too.
      remove: async (id) => {
        const p = read().find((x) => x.id === id);
        if (!p) return { ok: false, error: "That profile no longer exists." };
        const trashId = `${id}__${Date.now()}`;
        mockTrash.set(trashId, p);
        write(read().filter((x) => x.id !== id));
        return { ok: true, trashId };
      },
      restore: async (trashId) => {
        const p = mockTrash.get(trashId);
        if (!p) return { ok: false, error: "It can no longer be restored." };
        if (read().some((x) => x.id === p.id)) return { ok: false, error: `A profile named “${p.id}” exists again.` };
        mockTrash.delete(trashId);
        write([...read(), p]);
        return { ok: true, profile: p };
      },
      openData: async () => ({ ok: false, error: "Browser data lives in the desktop app." }),
    },
    launchTarget: async () => ({ mode: "preview" }),
    launch: async () => ({
      ok: false,
      error: "Launching only works in the desktop app (this is the browser preview).",
    }),
    stop: async () => {},
    running: async () => [],
    listVersions: async () => [], // browser preview has no catalog access; UI falls back to "latest"
    listRevisions: async () => [], // revisions need an authenticated PRO call — desktop app only
    onDownloadProgress: () => () => {}, // no downloads in the browser preview
    // The browser preview never offers a real update: there is no installed app to replace. A fake
    // release placed in localStorage["clearcote.mock.update"] stands in for GitHub, so the UI tests
    // can drive the banner — and it honours the Settings switch exactly like the main process does.
    update: {
      check: async (force?: boolean) => {
        let fake: UpdateInfo | null = null;
        try {
          fake = JSON.parse(localStorage.getItem("clearcote.mock.update") || "null") as UpdateInfo | null;
        } catch {
          fake = null;
        }
        if (!fake) return null;
        let s: Settings = {};
        try {
          s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Settings;
        } catch {
          /* defaults */
        }
        if (!force && s.updateCheck === false) return null;
        return fake;
      },
      download: async () => ({ ok: false, error: "Updating only works in the desktop app." }),
      run: async () => {},
      reveal: async () => {},
      openReleases: async (url: string) => {
        window.open(url, "_blank", "noopener");
      },
    },
    onUpdateProgress: () => () => {},
    cache: { list: async () => [], remove: async () => false }, // no on-disk cache in the browser
    settings: {
      get: async () => {
        try {
          return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Settings;
        } catch {
          return { theme: "dark" };
        }
      },
      set: async (s) => {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
        return s;
      },
    },
    license: {
      check: async () => ({
        ok: false,
        error: "License check runs in the desktop app.",
      }),
    },
    resolveBinary: async () => null,
    pickBinary: async () => null,
    geoCheck: async () => ({ ok: false, error: "IP / geo check runs in the desktop app." }),
    exportProfiles: async (opts) => {
      const only = opts?.ids?.length ? new Set(opts.ids) : null;
      const list = read().filter((p) => !only || only.has(p.id)).map((p) =>
        p.proxy ? { ...p, proxy: redactProxyString(p.proxy) } : p,
      );
      const blob = new Blob([JSON.stringify(list, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "clearcote-profiles.json";
      a.click();
      URL.revokeObjectURL(url);
      return { ok: true, count: list.length };
    },
    importProfiles: async () => ({ ok: false, error: "Import runs in the desktop app." }),
    fp: {
      import: async () => ({ ok: false, error: "Importing a fingerprint runs in the desktop app." }),
      library: async () => {
        const RAW = "https://raw.githubusercontent.com/clearcotelabs/clearcote-profiles/main/samples";
        try {
          const ir = await fetch(`${RAW}/index.json`);
          if (ir.ok) {
            const idx = (await ir.json()) as { profiles?: Array<Record<string, unknown>> };
            if (Array.isArray(idx.profiles) && idx.profiles.length) {
              return {
                ok: true,
                profiles: idx.profiles.map((e) => ({
                  name: `${e.id}.json`,
                  downloadUrl: `${RAW}/${e.id}.json`,
                  gpuVendor: e.gpu_vendor as string | undefined,
                  gpuFamily: e.gpu_family as string | undefined,
                  renderer: e.renderer as string | undefined,
                  screen: e.screen as string | undefined,
                  screenWarning: screenWarningFromLabel(e.screen as string | undefined) ?? undefined,
                })),
              };
            }
          }
        } catch {
          /* fall through to the directory listing */
        }
        try {
          const res = await fetch(
            "https://api.github.com/repos/clearcotelabs/clearcote-profiles/contents/samples",
          );
          if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
          const items = (await res.json()) as Array<{ name: string; download_url: string }>;
          return {
            ok: true,
            profiles: items
              .filter((i) => i.name?.endsWith(".json") && i.name !== "index.json")
              .map((i) => ({ name: i.name, downloadUrl: i.download_url })),
          };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      },
      use: async () => ({ ok: false, error: "Applying a fingerprint runs in the desktop app." }),
    },
  };
}

export const isElectron = typeof window !== "undefined" && !!window.clearcote;

export const api: ClearcoteApi =
  (typeof window !== "undefined" && window.clearcote) || buildMock();
