// Profile templates: a profile saved as a starting point. A new profile copies its settings, always
// gets its own seed and empty browser data, and asks only for what the template says changes each
// time — usually the proxy. Pure, so the page, the proxy-list dialog and the tests share one
// definition. Stored in the app's settings (Settings.templates), so the desktop app and the web
// version behind the helper see the same list; every profile made from one still goes through the
// normal save path, and with it the helper's rules.

import { randomGpu, type HostGpuVendor } from "./gpuPicker";
import type { Profile } from "@/types/profile";

export interface ProfileTemplate {
  id: string;
  name: string;
  /** "ask": every new profile starts without a proxy, and its region follows the one you give it. */
  proxy: "ask" | "keep";
  /** "fresh": every new profile gets a random GPU model of this computer's maker. */
  gpu: "keep" | "fresh";
  /** The settings a new profile copies — the source profile without the fields below. */
  base: Partial<Profile>;
  /** The profile it was saved from, as it was named then. */
  sourceName?: string;
  createdAt: string;
  updatedAt?: string;
  usedCount?: number;
  lastUsedAt?: string;
}

/** Never copied: what makes a profile itself rather than its settings. The browser data lives in
 *  the profile's own folder, so a new id is also a new, empty folder. */
const OWN_FIELDS = [
  "id",
  "name",
  "fingerprint",
  "createdAt",
  "updatedAt",
  "lastLaunchedAt",
  "lastGeo",
  "userDataDir",
  "encryptionKey",
] as const;

/** Values that describe where the proxy exits. With the proxy asked for, they would describe the
 *  old one, so they start empty and geoip fills them from the new one at launch. */
const FROM_PROXY = ["proxy", "timezone", "acceptLanguage", "location", "webrtcIp"] as const;

function strip(p: Partial<Profile>, keys: readonly string[]): Partial<Profile> {
  const out: Record<string, unknown> = { ...p };
  for (const k of keys) delete out[k];
  return out as Partial<Profile>;
}

/** A name for the template a profile would make: its group, else its name without a trailing number. */
export function suggestTemplateName(p: Profile): string {
  const g = p.group?.trim();
  if (g) return g;
  return (p.name || "").replace(/\s*(copy|\d+)\s*$/i, "").trim() || "Template";
}

export function templateFromProfile(
  p: Profile,
  choice: { name: string; proxy: ProfileTemplate["proxy"]; gpu: ProfileTemplate["gpu"] },
  now: string,
  id: string,
): ProfileTemplate {
  let base = strip(p, OWN_FIELDS);
  if (choice.proxy === "ask") base = strip(base, FROM_PROXY);
  return {
    id,
    name: choice.name.trim() || suggestTemplateName(p),
    proxy: choice.proxy,
    gpu: choice.gpu,
    base,
    sourceName: p.name || undefined,
    createdAt: now,
  };
}

/** Add a template, or replace the one with the same name (any case) — saving again under a name is
 *  how a template's settings are changed. A replaced template keeps its id and its use count. */
export function upsertTemplate(list: ProfileTemplate[], t: ProfileTemplate, now: string): ProfileTemplate[] {
  const same = list.find((x) => x.name.trim().toLowerCase() === t.name.trim().toLowerCase());
  if (!same) return [...list, t];
  const merged: ProfileTemplate = {
    ...t,
    id: same.id,
    createdAt: same.createdAt,
    updatedAt: now,
    usedCount: same.usedCount,
    lastUsedAt: same.lastUsedAt,
  };
  return list.map((x) => (x.id === same.id ? merged : x));
}

export function findTemplateByName(list: ProfileTemplate[], name: string): ProfileTemplate | undefined {
  const n = name.trim().toLowerCase();
  return list.find((x) => x.name.trim().toLowerCase() === n);
}

/** The next free number for "<template> <n>" among existing profile names. */
export function nextNumber(t: Pick<ProfileTemplate, "name">, names: string[]): number {
  const esc = t.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc}\\s+(\\d+)$`, "i");
  let max = 0;
  for (const n of names) {
    const m = re.exec(n.trim());
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** Platforms whose GPU strings the model table can write (see gpuPicker). */
const gpuPlatform = (p: Partial<Profile>) => !p.platform || p.platform === "windows" || p.platform === "linux";

/**
 * A new, unsaved profile from a template: the template's settings, a new seed, no id (so a new,
 * empty data folder on save), "<template> <n>" as its name, and — per the template — no proxy and
 * a random GPU.
 */
export function profileFromTemplate(
  t: ProfileTemplate,
  opts: { seed: string; now: string; number: number; hostVendor?: HostGpuVendor; rnd?: () => number },
): Profile {
  let p: Profile = {
    ...(t.base as Profile),
    id: "",
    name: `${t.name.trim()} ${opts.number}`,
    fingerprint: opts.seed,
    createdAt: opts.now,
    updatedAt: opts.now,
  };
  if (t.proxy === "ask") p = { ...(strip(p, FROM_PROXY) as Profile), geoip: true };
  if (t.gpu === "fresh" && gpuPlatform(p)) p = randomGpu(p, opts.hostVendor ?? "unknown", opts.rnd);
  return p;
}

/**
 * A profile from a proxy list, made from a template: the template's settings under the list
 * profile's own id, name, seed, proxy and dates; group and tags from the list dialog when it sets
 * them, else the template's.
 */
export function applyTemplate(
  listed: Profile,
  t: ProfileTemplate,
  opts: { hostVendor?: HostGpuVendor; rnd?: () => number } = {},
): Profile {
  let p: Profile = {
    ...(strip(t.base, FROM_PROXY) as Profile),
    id: listed.id,
    name: listed.name,
    fingerprint: listed.fingerprint,
    proxy: listed.proxy,
    geoip: listed.geoip,
    createdAt: listed.createdAt,
    updatedAt: listed.updatedAt,
  };
  if (listed.group) p.group = listed.group;
  if (listed.tags?.length) p.tags = listed.tags;
  if (t.gpu === "fresh" && gpuPlatform(p)) p = randomGpu(p, opts.hostVendor ?? "unknown", opts.rnd);
  return p;
}

/** Count `by` new profiles made from the template (a proxy list makes several at once). */
export function markUsed(list: ProfileTemplate[], id: string, now: string, by = 1): ProfileTemplate[] {
  return list.map((t) => (t.id === id ? { ...t, usedCount: (t.usedCount ?? 0) + by, lastUsedAt: now } : t));
}

/** Most recently used first, then most used, then by name — the order of the New profile menu. */
export function sortTemplates(list: ProfileTemplate[]): ProfileTemplate[] {
  return [...list].sort(
    (a, b) =>
      (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "") ||
      (b.usedCount ?? 0) - (a.usedCount ?? 0) ||
      a.name.localeCompare(b.name),
  );
}

/** What a template does, in a few words: "asks proxy · new GPU · used 3×". */
export function describeTemplate(t: ProfileTemplate): string {
  const parts = [t.proxy === "ask" ? "asks proxy" : "same proxy", t.gpu === "fresh" ? "new GPU" : "same GPU"];
  if (t.usedCount) parts.push(`used ${t.usedCount}×`);
  return parts.join(" · ");
}

/** Templates as stored, with anything malformed dropped — settings.json is a file people edit. */
export function readTemplates(raw: unknown): ProfileTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (t): t is ProfileTemplate =>
      !!t &&
      typeof t === "object" &&
      typeof (t as ProfileTemplate).id === "string" &&
      typeof (t as ProfileTemplate).name === "string" &&
      !!(t as ProfileTemplate).base &&
      typeof (t as ProfileTemplate).base === "object",
  ).map((t) => ({ ...t, proxy: t.proxy === "keep" ? "keep" : "ask", gpu: t.gpu === "fresh" ? "fresh" : "keep" }));
}
