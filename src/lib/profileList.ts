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
  profiles: Profile[];
}

/** Split an already-sorted list into group sections, keeping the sort inside each. Groups appear in
 *  the order their first member does; "Work" and "work " are one group, shown as first written. */
export function groupProfiles(list: Profile[]): Section[] {
  const named = new Map<string, Section>();
  const loose: Profile[] = [];
  for (const p of list) {
    const g = p.group?.trim();
    if (!g) {
      loose.push(p);
      continue;
    }
    const key = g.toLowerCase();
    const s = named.get(key) ?? { group: g, profiles: [] };
    s.profiles.push(p);
    named.set(key, s);
  }
  if (named.size === 0) return [{ group: null, profiles: loose }];
  const out = [...named.values()];
  if (loose.length) out.push({ group: null, profiles: loose });
  return out;
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
