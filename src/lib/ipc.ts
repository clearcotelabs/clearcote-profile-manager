// Renderer-side bridge to the Electron main process.
// In the desktop app, window.clearcote is injected by electron/preload.ts.
// In a plain browser (next dev / preview), fall back to a localStorage-backed mock
// so the UI is fully usable for design + testing without Electron.

import { redactProxyString, type Profile } from "@/types/profile";

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
  /** PRO license key (`cc_lic_...`). Set = launches use the license-gated PRO browser
   *  + a floating-concurrency slot. Empty = free mode (no backend contact). */
  licenseKey?: string;
  licenseApiBase?: string;
}
export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
  /** True when the launch used the PRO (license-gated) binary + a leased run-token. */
  pro?: boolean;
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
  error?: string;
}

export interface FingerprintMeta {
  label?: string;
  renderer?: string;
  cores?: number;
  memory?: number;
  screen?: string;
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

export interface ClearcoteApi {
  profiles: {
    list: () => Promise<Profile[]>;
    get: (id: string) => Promise<Profile | null>;
    save: (p: Profile) => Promise<Profile>;
    remove: (id: string) => Promise<void>;
  };
  launch: (p: Profile) => Promise<LaunchResult>;
  stop: (id: string) => Promise<void>;
  running: () => Promise<string[]>;
  /** Public browser-build catalog for this OS (newest major first). Drives the version dropdown. */
  listVersions: () => Promise<VersionOption[]>;
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  license: {
    check: (key?: string) => Promise<LicenseStatus>;
  };
  resolveBinary: () => Promise<string | null>;
  pickBinary: () => Promise<string | null>;
  geoCheck: (p: Profile) => Promise<GeoResult>;
  exportProfiles: (opts?: { redact?: boolean }) => Promise<ExportResult>;
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
      remove: async (id) => write(read().filter((p) => p.id !== id)),
    },
    launch: async () => ({
      ok: false,
      error: "Launching only works in the desktop app (this is the browser preview).",
    }),
    stop: async () => {},
    running: async () => [],
    listVersions: async () => [], // browser preview has no catalog access; UI falls back to "latest"
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
    exportProfiles: async () => {
      const list = read().map((p) =>
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
