// The design preview's extensions (no backend): kept in localStorage like the mock profiles, so the
// Extensions page, the editor's picker and the e2e tests have something real to show. Adding from the
// store makes an entry from the ID alone; nothing is downloaded.

import type { ExtensionEntry } from "../../electron/extensions";
import type { Profile } from "@/types/profile";
import type { ExtensionsApi } from "@/lib/ipc";
import { t } from "@/lib/i18n";

export const EXTENSIONS_KEY = "clearcote.extensions.mock";

export function buildExtensionsMock(profilesKey: string): ExtensionsApi {
  const listeners = new Set<() => void>();
  const read = (): ExtensionEntry[] => {
    try {
      return JSON.parse(localStorage.getItem(EXTENSIONS_KEY) || "[]");
    } catch {
      return [];
    }
  };
  const write = (l: ExtensionEntry[]) => {
    localStorage.setItem(EXTENSIONS_KEY, JSON.stringify(l));
    listeners.forEach((cb) => cb());
  };
  const readProfiles = (): Profile[] => {
    try {
      return JSON.parse(localStorage.getItem(profilesKey) || "[]");
    } catch {
      return [];
    }
  };
  const setOn = (extId: string, ids: string[] | null, on: boolean): number => {
    let n = 0;
    const ps = readProfiles().map((p) => {
      if (ids && !ids.includes(p.id)) return p;
      const had = (p.extensions ?? []).includes(extId);
      if (had === on) return p;
      n++;
      const list = on ? [...(p.extensions ?? []), extId] : (p.extensions ?? []).filter((x) => x !== extId);
      return { ...p, extensions: list.length ? list : undefined };
    });
    localStorage.setItem(profilesKey, JSON.stringify(ps));
    return n;
  };
  const add = (id: string, source: ExtensionEntry["source"], from: string) => {
    const now = Date.now();
    const prev = read().find((e) => e.id === id);
    const entry: ExtensionEntry = {
      id,
      name: prev?.name ?? `Extension ${id.slice(0, 6)}`,
      version: prev?.version ?? "1.0.0",
      source,
      from,
      autoUpdate: prev?.autoUpdate ?? false,
      key: "",
      addedAt: prev?.addedAt ?? now,
      updatedAt: now,
      ...(source === "store" ? { checkedAt: now } : {}),
    };
    write([...read().filter((e) => e.id !== id), entry].sort((a, b) => a.name.localeCompare(b.name)));
    return { ok: true as const, extension: entry };
  };
  return {
    list: async () => read(),
    addStore: async (ref) => {
      const s = String(ref).trim();
      const id = /^[a-p]{32}$/.test(s) ? s : /\/([a-p]{32})(?:[/?#]|$)/.exec(s)?.[1];
      if (!id) return { ok: false, error: t("Paste a Chrome Web Store link (chromewebstore.google.com/detail/…) or a 32-letter extension ID.") };
      return add(id, "store", id);
    },
    addCrxData: async (_b64, fileName) => add("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "crx", fileName ?? "extension.crx"),
    update: async (id) => {
      const e = read().find((x) => x.id === id);
      return e ? { ok: true, extension: e } : { ok: false, error: t("That extension is no longer here.") };
    },
    checkAll: async () => ({ updated: [], available: [], failed: [] }),
    set: async (id, patch) => {
      const e = read().find((x) => x.id === id);
      if (!e) return { ok: false, error: t("That extension is no longer here.") };
      const next = { ...e, autoUpdate: e.source === "store" && !!patch.autoUpdate };
      write(read().map((x) => (x.id === id ? next : x)));
      return { ok: true, extension: next };
    },
    remove: async (id) => {
      const profilesChanged = setOn(id, null, false);
      write(read().filter((e) => e.id !== id));
      return { ok: true, profilesChanged };
    },
    assign: async (id, ids, on) => {
      const n = setOn(id, ids, on);
      listeners.forEach((cb) => cb());
      return n;
    },
    onChanged: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
