// Pure helpers behind the workspace layout: the sidebar's views, the table's columns and the Proxies
// page. No React, no Electron, so each rule is pinned by tests/workspace.test.ts.

import type { Profile } from "@/types/profile";
import { parseProxy } from "../../electron/proxyargs";
import { coherenceIssues, type CoherenceContext, type Issue } from "./coherence";
import { displayName, proxySummary } from "./profileList";
import { tx } from "./i18n";

/** The list the sidebar shows. "attention" = something to fix; "recent" = launched in the last week. */
export type ViewKey = "all" | "running" | "attention" | "recent";

export const VIEW_LABELS: Record<ViewKey, string> = {
  all: tx("All profiles"),
  running: tx("Running"),
  attention: tx("Needs attention"),
  recent: tx("Used this week"),
};

const WEEK = 7 * 24 * 3600_000;

/** Coherence ERRORS only: a warning is a judgement call, and a view that lists every profile with a
 *  soft warning would be ignored within a day. */
export function profileErrors(p: Profile, ctx: CoherenceContext = {}): Issue[] {
  try {
    return coherenceIssues(p as unknown as Record<string, unknown>, ctx).filter((i) => i.severity === "error");
  } catch {
    return [];
  }
}

/** Why a profile needs attention, worst first: a launch error or warning still on it, then its
 *  coherence errors. Empty when nothing is wrong. */
export function attentionReasons(
  p: Profile,
  notice: { tone: "error" | "warning"; title: string } | undefined,
  ctx: CoherenceContext = {},
): { text: string; field?: string }[] {
  const out: { text: string; field?: string }[] = [];
  if (notice) out.push({ text: notice.title });
  for (const i of profileErrors(p, ctx)) out.push({ text: i.message, field: i.field });
  return out;
}

export function inView(
  p: Profile,
  view: ViewKey,
  o: { active: ReadonlySet<string>; attention: ReadonlySet<string>; now?: number },
): boolean {
  if (view === "running") return o.active.has(p.id);
  if (view === "attention") return o.attention.has(p.id);
  if (view === "recent") {
    const at = p.lastLaunchedAt ? Date.parse(p.lastLaunchedAt) : NaN;
    return Number.isFinite(at) && (o.now ?? Date.now()) - at < WEEK;
  }
  return true;
}

/** "windows · Chrome 156" — the persona a profile claims, short, for a table cell. */
export function personaLabel(p: Profile): string {
  const os = p.platform || "";
  const brand = p.brand || "Chrome";
  const ver = (p.brandVersion || "").split(".")[0];
  return [os, ver ? `${brand} ${ver}` : brand].filter(Boolean).join(" · ");
}

/** Tag → count, most used first, then by name. */
export function tagCounts(profiles: Profile[]): { tag: string; count: number }[] {
  const m = new Map<string, { tag: string; count: number }>();
  for (const p of profiles)
    for (const raw of p.tags ?? []) {
      const tag = raw.trim();
      if (!tag) continue;
      const k = tag.toLowerCase();
      const cur = m.get(k);
      if (cur) cur.count++;
      else m.set(k, { tag, count: 1 });
    }
  return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** One proxy as the Proxies page lists it: every profile using the same scheme://host:port is one
 *  row, whatever credentials each holds (a rotating pool often differs only by session username). */
export interface ProxyRow {
  /** "socks5 host:port" — also what `lastGeo.proxy` records. */
  key: string;
  scheme: string;
  host: string;
  port: number;
  /** Profiles using it, by name order. */
  profiles: Profile[];
  /** True when at least one profile sends a username. */
  auth: boolean;
  /** The newest exit measured through it, from any of its profiles. */
  lastGeo?: Profile["lastGeo"];
}

export function proxyInventory(profiles: Profile[]): ProxyRow[] {
  const rows = new Map<string, ProxyRow>();
  for (const p of profiles) {
    const parsed = parseProxy(p.proxy);
    const key = proxySummary(p.proxy);
    if (!parsed || !key) continue;
    let row = rows.get(key);
    if (!row) {
      row = { key, scheme: parsed.scheme, host: parsed.host, port: parsed.port, profiles: [], auth: false };
      rows.set(key, row);
    }
    row.profiles.push(p);
    if (parsed.username) row.auth = true;
    const g = p.lastGeo;
    if (g && g.proxy === key && (!row.lastGeo || Date.parse(g.at) > Date.parse(row.lastGeo.at))) row.lastGeo = g;
  }
  for (const r of rows.values())
    r.profiles.sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true }));
  return [...rows.values()].sort((a, b) => b.profiles.length - a.profiles.length || a.key.localeCompare(b.key));
}

/** Point a profile at another proxy server while keeping its own login, so swapping a dead server
 *  for a new one in a pool keeps each profile's sticky-session username. `to` may carry its own
 *  credentials, which then win. Returns the profile unchanged when its proxy isn't `fromKey`. */
export function replaceProxy(p: Profile, fromKey: string, to: string): Profile {
  if (proxySummary(p.proxy) !== fromKey) return p;
  const next = parseProxy(to);
  const old = parseProxy(p.proxy);
  if (!next || !old) return p;
  const user = next.username ?? old.username;
  const pass = next.username ? next.password : old.password;
  const auth = user ? `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ""}@` : "";
  // parseProxy keeps an IPv6 host's brackets.
  return { ...p, proxy: `${next.scheme}://${auth}${next.host}:${next.port}` };
}
