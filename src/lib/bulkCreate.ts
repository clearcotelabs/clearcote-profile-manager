// Many profiles from a pasted proxy list — the usual way this tool is used at scale.
// PURE, so every rule below is pinned by a test.
//
// Accepted per line (blank lines and "# comments" are ignored):
//   scheme://user:pass@host:port   user:pass@host:port   host:port
//   host:port:user:pass            ← how most proxy providers export their lists
// Each valid, not-yet-seen proxy becomes one profile with its own random seed.

import type { Platform, Profile } from "@/types/profile";
import { parseProxy } from "../../electron/proxyargs";

export interface BulkOptions {
  /** "{n}" is the running number, "{host}" the proxy host. Without "{n}", " {n}" is appended so
   *  names stay unique. */
  namePattern: string;
  group?: string;
  tags?: string[];
  platform?: Platform;
  /** Timezone, language and location follow each proxy's exit region at launch. */
  geoip: boolean;
  /** First number used for "{n}". */
  startAt?: number;
}

export interface BulkResult {
  profiles: Profile[];
  /** Lines that are not a proxy address, with their 1-based line numbers. */
  invalid: { line: number; text: string }[];
  /** Repeats of a proxy already on an earlier line. */
  duplicates: number;
}

/** "host:port:user:pass" → a URL the rest of the app understands. Other forms pass through. */
export function normalizeProxyLine(line: string): string {
  const v = line.trim();
  const m = /^([^\s:/@]+):(\d{1,5}):([^\s:@]+):(.+)$/.exec(v);
  if (m) return `http://${encodeURIComponent(m[3])}:${encodeURIComponent(m[4])}@${m[1]}:${m[2]}`;
  return v;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "profile";

const defaultSeed = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);

export function profilesFromProxyList(
  text: string,
  opts: BulkOptions,
  existingIds: Iterable<string> = [],
  deps: { now?: string; seed?: () => string; suffix?: () => string } = {},
): BulkResult {
  const now = deps.now ?? new Date().toISOString();
  const seed = deps.seed ?? defaultSeed;
  const suffix = deps.suffix ?? (() => Math.random().toString(36).slice(2, 6));
  const taken = new Set(existingIds);
  const seen = new Set<string>();
  const invalid: BulkResult["invalid"] = [];
  const profiles: Profile[] = [];
  let duplicates = 0;
  let n = opts.startAt ?? 1;
  const pattern = opts.namePattern.trim() || "Profile {n}";
  const withNumber = pattern.includes("{n}") ? pattern : `${pattern} {n}`;

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const proxy = normalizeProxyLine(line);
    const parsed = parseProxy(proxy);
    // A bare word parses as "http://word:80"; a real entry names a port or a scheme.
    if (!parsed || !parsed.host || !/:\d{1,5}(\/|$)|^[a-z0-9+.-]+:\/\//i.test(proxy)) {
      invalid.push({ line: i + 1, text: line });
      return;
    }
    const key = `${parsed.scheme}://${parsed.username ?? ""}@${parsed.host}:${parsed.port}`.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    const name = withNumber.replace(/\{n\}/g, String(n)).replace(/\{host\}/g, parsed.host).trim();
    let id = `${slug(name)}-${suffix()}`;
    while (taken.has(id)) id = `${slug(name)}-${suffix()}`;
    taken.add(id);
    const p: Profile = {
      id,
      name,
      fingerprint: seed(),
      platform: opts.platform ?? "windows",
      geoip: opts.geoip,
      proxy,
      createdAt: now,
      updatedAt: now,
    };
    if (opts.group?.trim()) p.group = opts.group.trim();
    const tags = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
    if (tags.length) p.tags = tags;
    profiles.push(p);
    n++;
  });
  return { profiles, invalid, duplicates };
}
