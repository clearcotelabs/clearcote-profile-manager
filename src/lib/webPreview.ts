// The web version before this computer is connected: the whole app, running on the browser-only
// preview (ipc.ts buildMock) with a few example profiles, so people can see what they are getting.
// Anything that needs the computer (launching, the cloud, settings, files) asks for the helper
// instead: it fires "clearcote:need-helper", and HelperGate opens the connect window.
// After pairing, the app switches to the helper and the profiles made here move to the computer.

import type { ClearcoteApi } from "./ipc";
import type { Profile } from "@/types/profile";
import { newProfile } from "./newProfile";
import { t, tx } from "./i18n";

/** A result's code when the preview could not do it: the UI skips its own error for these. */
export const NEEDS_HELPER = "NEEDS_HELPER";
export const NEED_HELPER_EVENT = "clearcote:need-helper";
/** The reason the account sign-in gives when it needs the helper: after pairing, it carries on. */
export const ACCOUNT_WHY = tx("use your Clearcote account");

export function askForHelper(why: string) {
  window.dispatchEvent(new CustomEvent(NEED_HELPER_EVENT, { detail: why }));
}

export const needsHelper = (r: unknown) => !!r && typeof r === "object" && (r as { code?: string }).code === NEEDS_HELPER;

/** The preview API: the mock, with every call that needs the computer turned into a request for it. */
export function buildPreviewApi(mock: ClearcoteApi): ClearcoteApi {
  const fail =
    (why: string) =>
    async (..._a: unknown[]) => {
      askForHelper(why);
      return { ok: false as const, error: t("Connect this computer first."), code: NEEDS_HELPER };
    };
  return {
    ...mock,
    profiles: {
      ...mock.profiles,
      openData: fail(tx("open a profile's browser data")),
      clearCache: fail(tx("clear a profile's cache")),
    },
    checkProfileGeo: fail(tx("check where a proxy exits")) as ClearcoteApi["checkProfileGeo"],
    storage: {
      ...mock.storage,
      prefetch: fail(tx("download the browser")),
      clearProfiles: async () => {
        askForHelper(tx("clear profiles' browser data"));
        return { freedBytes: 0, cleared: [], running: [], failed: [], error: t("Connect this computer first."), code: NEEDS_HELPER };
      },
    },
    launchTarget: async () => ({ mode: "preview" }),
    launch: fail(tx("launch a browser")),
    // Tasks show as in the desktop app; running one, setting up Jet or saving a task needs the computer.
    sync: mock.sync && { ...mock.sync, start: fail(tx("run a task on profiles")) as NonNullable<ClearcoteApi["sync"]>["start"] },
    // Nothing on the computer can be checked yet, so no setup checklist (it would say Python is missing).
    jetSetup: undefined,
    tasks: mock.tasks && {
      ...mock.tasks,
      save: fail(tx("save a task")) as never,
      saveSteps: fail(tx("save a task's steps")) as never,
      resetSteps: fail(tx("save a task's steps")) as never,
    },
    cdpEndpoint: undefined,
    // Extensions show as in the desktop app; adding one or turning it on needs the computer.
    extensions: mock.extensions && {
      ...mock.extensions,
      addStore: fail(tx("add an extension")) as never,
      addCrxData: fail(tx("add an extension")) as never,
      assign: async () => {
        askForHelper(tx("turn an extension on for profiles"));
        return 0;
      },
    },
    cloud: {
      ...mock.cloud,
      start: fail(tx("run a profile in the cloud")) as ClearcoteApi["cloud"]["start"],
      account: fail(tx("check your API key")),
    },
    // Keys never go into this browser's storage: settings are saved on the computer.
    settings: {
      get: mock.settings.get,
      set: async () => {
        askForHelper(tx("save settings"));
        return mock.settings.get();
      },
    },
    license: { check: fail(tx("check your licence")), loginStart: fail(ACCOUNT_WHY), loginPoll: fail(ACCOUNT_WHY) as never },
    pickBinary: async () => {
      askForHelper(tx("choose a browser"));
      return null;
    },
    geoCheck: fail(tx("check where a proxy exits")),
    proxyCheck: fail(tx("check a proxy")),
    importProfiles: fail(tx("import profiles")),
    migrateImport: fail(tx("import profiles")),
    importCookies: fail(tx("import cookies")),
    // No full library in the preview: it is built and kept on a computer (the helper's or the desktop app's).
    fp: { ...mock.fp, import: fail(tx("import a fingerprint")), use: fail(tx("use a library fingerprint")), fullLibrary: undefined },
  };
}

/** One object whose calls go to whichever API `pick` names at call time. The same key gives the same
 *  function or object every time, as the desktop app's API does: components keep them in hook deps
 *  (a new `api.jetSetup` on every render made JetSetup ask for Jet's status in a loop). */
export function switchable<T extends object>(pick: () => T): T {
  const fns = new Map<PropertyKey, (...a: unknown[]) => unknown>();
  const objs = new Map<PropertyKey, object>();
  return new Proxy({} as T, {
    get(_t, k) {
      const v = (pick() as Record<PropertyKey, unknown>)[k];
      if (typeof v === "function") {
        if (!fns.has(k)) fns.set(k, (...a: unknown[]) => ((pick() as Record<PropertyKey, (...x: unknown[]) => unknown>)[k])(...a));
        return fns.get(k);
      }
      if (v && typeof v === "object") {
        if (!objs.has(k)) objs.set(k, switchable(() => (pick() as Record<PropertyKey, object>)[k]));
        return objs.get(k);
      }
      return v;
    },
  });
}

// ── Example profiles ──────────────────────────────────────────────────────────

const SEEDED_KEY = "clearcote.preview.seeded";
const EXAMPLE_TAG = "example";

function example(id: string, name: string, platform: "windows" | "macos", extra: Partial<Profile>): Profile {
  return { ...newProfile(id, new Date().toISOString(), platform), ...extra, id: `example-${id}`, name, tags: [EXAMPLE_TAG] };
}

/** Put the example profiles in the preview once, the first time this browser opens it. */
export function seedExamples(profilesKey: string) {
  try {
    if (localStorage.getItem(SEEDED_KEY)) return;
    const have = JSON.parse(localStorage.getItem(profilesKey) || "[]") as Profile[];
    if (!have.length) {
      const list = [
        example("shop", t("Online shop — seller account"), "windows", { group: t("Shops"), notes: t("An example. Launch it to see a real browser start on your computer.") }),
        example("ads", t("Ads check — Germany"), "windows", { group: t("Marketing"), timezone: "Europe/Berlin", acceptLanguage: "de-DE,de;q=0.9,en;q=0.8" }),
        example("research", t("Research"), "macos", { group: t("Research") }),
      ];
      localStorage.setItem(profilesKey, JSON.stringify(list));
    }
    localStorage.setItem(SEEDED_KEY, "1");
  } catch {
    /* storage blocked: the preview starts empty */
  }
}

/** Profiles made in the preview (not the examples), to move to the computer after pairing. */
export function previewProfiles(profilesKey: string): Profile[] {
  try {
    const all = JSON.parse(localStorage.getItem(profilesKey) || "[]") as Profile[];
    return all.filter((p) => !p.id.startsWith("example-") && !(p.tags ?? []).includes(EXAMPLE_TAG));
  } catch {
    return [];
  }
}

/** After they moved: the preview keeps only the examples. */
export function forgetPreviewProfiles(profilesKey: string, moved: Profile[]) {
  try {
    const ids = new Set(moved.map((p) => p.id));
    const all = JSON.parse(localStorage.getItem(profilesKey) || "[]") as Profile[];
    localStorage.setItem(profilesKey, JSON.stringify(all.filter((p) => !ids.has(p.id))));
  } catch {
    /* nothing to do */
  }
}
