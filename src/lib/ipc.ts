// Renderer-side bridge to the Electron main process.
// In the desktop app, window.clearcote is injected by electron/preload.ts.
// In a plain browser (next dev / preview), fall back to a localStorage-backed mock
// so the UI is fully usable for design + testing without Electron.

import type { Profile } from "@/types/profile";

export interface Settings {
  binaryPath?: string;
  theme?: "dark" | "light";
}
export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
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
}
export interface FpListResult {
  ok: boolean;
  profiles?: LibraryProfile[];
  error?: string;
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
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
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
    resolveBinary: async () => null,
    pickBinary: async () => null,
    geoCheck: async () => ({ ok: false, error: "IP / geo check runs in the desktop app." }),
    exportProfiles: async () => {
      const list = read().map((p) =>
        p.proxy ? { ...p, proxy: { ...p.proxy, password: p.proxy.password ? "" : undefined } } : p,
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
        try {
          const res = await fetch(
            "https://api.github.com/repos/clearcotelabs/clearcote-profiles/contents/samples",
          );
          if (!res.ok) return { ok: false, error: `GitHub API ${res.status}` };
          const items = (await res.json()) as Array<{ name: string; download_url: string }>;
          return {
            ok: true,
            profiles: items
              .filter((i) => i.name?.endsWith(".json"))
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
