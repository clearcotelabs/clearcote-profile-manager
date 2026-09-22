// Pure helpers behind the profile list: ordering, grouping, and the short facts a card shows.
// No React, no Electron — so each rule here is pinned by a unit test rather than by eye.

import type { Profile } from "@/types/profile";
// The PURE proxy module (no node:net), same as src/types/profile.ts uses.
import { parseProxy } from "../../electron/proxyargs";

export type SortKey = "recent" | "name" | "created";

export const SORT_LABELS: Record<SortKey, string> = {
  recent: "Recently used",
  name: "Name",
  created: "Newest",
};

const ts = (iso?: string) => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

export const displayName = (p: Profile): string => p.name?.trim() || p.id;

const byName = (a: Profile, b: Profile) =>
  displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: "base" }) ||
  a.id.localeCompare(b.id);

/**
 * "recent": running profiles first (they are what you are working with), then the most recent of
 * last launch and last edit. "name" and "created" are exactly what they say, with no running-first
 * exception — an alphabetical list that reshuffles when something starts is not alphabetical.
 */
export function sortProfiles(list: Profile[], running: string[], key: SortKey): Profile[] {
  const run = new Set(running);
  const used = (p: Profile) => Math.max(ts(p.lastLaunchedAt), ts(p.updatedAt));
  const cmp: Record<SortKey, (a: Profile, b: Profile) => number> = {
    recent: (a, b) => Number(run.has(b.id)) - Number(run.has(a.id)) || used(b) - used(a) || byName(a, b),
    name: byName,
    created: (a, b) => ts(b.createdAt) - ts(a.createdAt) || byName(a, b),
  };
  return [...list].sort(cmp[key]);
}

export interface Section {
  /** null: profiles with no group (headed "No group" only when named groups exist too). */
  group: string | null;
  /** Lower-cased, trimmed — what order and collapse state are keyed on. "" for no group. */
  key: string;
  profiles: Profile[];
}

/** How a group is matched everywhere: "Work" and " work" are one group. */
export const groupKey = (g: string | undefined | null): string => (g ?? "").trim().toLowerCase();

/**
 * Split an already-sorted list into group sections, keeping the sort inside each. Groups listed in
 * `order` (keys) come first, in that order — the person arranged them; the rest follow in the order
 * their first member appears. "Work" and "work " are one group, shown as first written.
 */
export function groupProfiles(list: Profile[], order: string[] = []): Section[] {
  const named = new Map<string, Section>();
  const loose: Profile[] = [];
  for (const p of list) {
    const g = p.group?.trim();
    if (!g) {
      loose.push(p);
      continue;
    }
    const key = g.toLowerCase();
    const s = named.get(key) ?? { group: g, key, profiles: [] };
    s.profiles.push(p);
    named.set(key, s);
  }
  if (named.size === 0) return [{ group: null, key: "", profiles: loose }];
  const rank = (k: string) => {
    const i = order.indexOf(k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const appear = [...named.keys()];
  const out = [...named.values()].sort((a, b) => rank(a.key) - rank(b.key) || appear.indexOf(a.key) - appear.indexOf(b.key));
  if (loose.length) out.push({ group: null, key: "", profiles: loose });
  return out;
}

/** The group order after moving `key` one place up (-1) or down (+1) among the groups shown. */
export function moveGroup(shown: string[], key: string, dir: -1 | 1): string[] {
  const order = shown.filter((k) => k !== "");
  const i = order.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  [order[i], order[j]] = [order[j], order[i]];
  return order;
}

/**
 * The selection after a click on `id`. A range click (Shift) selects every profile shown between
 * the previous click (`from`) and this one; otherwise the click toggles just `id`. `from` must be
 * read when the click happens — see the page's toggleSelect for why.
 */
export function nextSelection(
  prev: ReadonlySet<string>,
  id: string,
  opts: { range: boolean; from: string | null; order: string[] },
): Set<string> {
  const next = new Set(prev);
  const a = opts.from ? opts.order.indexOf(opts.from) : -1;
  const b = opts.order.indexOf(id);
  if (opts.range && a >= 0 && b >= 0) {
    for (const x of opts.order.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
  } else if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export interface ListFilter {
  query?: string;
  /** Only profiles carrying this tag (case-insensitive). */
  tag?: string;
  /** Only this group (a groupKey; "" = profiles with no group). */
  group?: string;
  runningOnly?: boolean;
}

/** The text a search matches: names, ids, groups, notes, versions, proxies, exit country, tags. */
function haystack(p: Profile): string {
  return [
    p.name,
    p.id,
    p.fingerprint,
    p.group,
    p.notes,
    p.browserVersion,
    proxySummary(p.proxy),
    p.lastGeo?.country,
    p.lastGeo?.city,
    p.lastGeo?.countryCode,
    ...(p.tags || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function filterProfiles(list: Profile[], f: ListFilter, running: string[] = []): Profile[] {
  const q = (f.query ?? "").toLowerCase().trim();
  const tag = f.tag?.trim().toLowerCase();
  const run = new Set(running);
  return list.filter(
    (p) =>
      (!q || haystack(p).includes(q)) &&
      (!tag || (p.tags || []).some((t) => t.trim().toLowerCase() === tag)) &&
      (f.group === undefined || groupKey(p.group) === f.group) &&
      (!f.runningOnly || run.has(p.id)),
  );
}

/**
 * Where the profile's traffic exits, for its card — or null when unknown or measured for a
 * DIFFERENT proxy than the one it has now (an old answer about another proxy is worse than none).
 */
export function geoLabel(p: Profile, now = Date.now()): { text: string; title: string } | null {
  const g = p.lastGeo;
  const px = proxySummary(p.proxy);
  if (!g || !px || g.proxy !== px || !(g.countryCode || g.country)) return null;
  const place = [g.city, g.countryCode || g.country].filter(Boolean).join(", ");
  const when = relativeTime(g.at, now);
  return {
    text: place,
    title: `Exits via ${px}${g.ip ? ` as ${g.ip}` : ""}${g.country ? ` (${g.country})` : ""}${when ? `, checked ${when}` : ""}.`,
  };
}

/** "just now" · "5 minutes ago" · "yesterday" · "3 weeks ago" · then a date. */
export function relativeTime(iso: string | undefined, now = Date.now()): string | null {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return null;
  const s = Math.round((now - at) / 1000);
  if (s < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 7) return rtf.format(-d, "day");
  if (d < 35) return rtf.format(-Math.round(d / 7), "week");
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export interface VersionInfo {
  kind: "latest" | "major" | "exact";
  /** The chip text. */
  label: string;
}

export function versionInfo(v?: string): VersionInfo {
  const raw = (v ?? "").trim();
  if (!raw || /^(latest|auto)$/i.test(raw)) return { kind: "latest", label: "latest build" };
  if (/^\d+$/.test(raw)) return { kind: "major", label: `build ${raw}` };
  return { kind: "exact", label: `pinned ${raw}` };
}

/**
 * Would the free plan refuse this profile's version? It serves only the current build — naming the
 * current build (its major, version or tag) is fine, anything else is a Pro pin. Unknown current
 * build ⇒ no verdict, so a card never warns on a guess.
 */
export function pinRefusedOnFree(v: string | undefined, current?: { version?: string; major?: number }): boolean {
  const info = versionInfo(v);
  if (info.kind === "latest" || !current?.version) return false;
  const raw = (v ?? "").trim().toLowerCase();
  if (info.kind === "major") return Number(raw) !== current.major;
  const want = raw.replace(/^pro-/, "");
  return !(want === current.version || want.startsWith(current.version + "-"));
}

/** "socks5 proxy.example:1080" — never the credentials. */
export function proxySummary(proxy: unknown): string | null {
  const p = parseProxy(proxy);
  return p ? `${p.scheme} ${p.host}:${p.port}` : null;
}

/** Deep compare that ignores the ways an editor round-trip changes nothing: key order, emptied
 *  strings, emptied lists (tags typed and deleted leave [] where there was nothing). */
export function isProfileDirty(current: Profile, initial: Profile): boolean {
  return JSON.stringify(normalize(current)) !== JSON.stringify(normalize(initial));
}

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? v.map(normalize) : undefined;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const n = normalize((v as Record<string, unknown>)[k]);
      if (n !== undefined) out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return v === "" || v === null ? undefined : v;
}
