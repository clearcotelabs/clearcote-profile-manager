// Moving in from another browser: cookie files and other antidetect browsers' exports.
//
// Two things come in. A cookie file (Netscape cookies.txt, or the JSON that EditThisCookie, Cookie-Editor,
// Puppeteer/Playwright and most antidetect browsers write) is attached to a profile and written into its
// browser at the next launch (electron/cookiejar.ts). A profile list (JSON or CSV/TSV exported from
// AdsPower, Dolphin Anty, GoLogin, Multilogin, Octo and the like) becomes new profiles: name, notes, tags,
// group, proxy and cookies come across; the OS family is read from the old user-agent.
//
// The old fingerprint is NOT copied. Its canvas/WebGL/audio noise is often why accounts got linked; the new
// profile gets a persona from a real device of the same OS family instead.
//
// Vendor exports are read by field name, with the aliases each tool is known to use, not by a fixed
// schema per vendor: their formats change between versions, and a row we cannot fully read still keeps
// what we could (a warning says what was left out).

import { normalizeProxy } from "./proxyargs";
import { parseTotp } from "./totp";

/** A cookie as DevTools' Storage.setCookies takes it. A host-only cookie carries `url` instead of `domain`. */
export interface ImportedCookie {
  name: string;
  value: string;
  domain?: string;
  url?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  /** Seconds since the epoch; absent for a session cookie. */
  expires?: number;
}

export interface CookieParse {
  cookies: ImportedCookie[];
  /** Entries that were not cookies we can set (no name, no domain, unreadable). */
  skipped: number;
  /** Cookies already past their expiry. */
  expired: number;
}

/** A profile read from another tool's export, before it gets an id and a persona. */
export interface MigratedProfile {
  name: string;
  notes?: string;
  tags?: string[];
  group?: string;
  /** Normalised proxy string, as the profile editor saves it. */
  proxy?: string;
  platform?: "windows" | "macos" | "linux" | "android";
  /** The account's 2FA secret, when the export had one. */
  totp?: string;
  cookies: ImportedCookie[];
}

export interface MigrationParse {
  profiles: MigratedProfile[];
  /** Rows that held nothing we could use. */
  skipped: number;
  cookies: number;
  /** One line each, said to the user: what did not come across and why. */
  warnings: string[];
}

// ── cookies ─────────────────────────────────────────────────────────────────────────────────────

const SAME_SITE: Record<string, ImportedCookie["sameSite"]> = {
  strict: "Strict",
  lax: "Lax",
  none: "None",
  no_restriction: "None", // chrome.cookies / EditThisCookie
  norestriction: "None",
};

const truthy = (v: unknown) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? "").trim());

/** Build a settable cookie, or null. `hostOnly` false means it is sent to subdomains too. */
function makeCookie(
  f: { name: unknown; value: unknown; domain: unknown; path?: unknown; secure?: unknown; httpOnly?: unknown; sameSite?: unknown; expires?: unknown; hostOnly?: unknown; session?: unknown },
  now: number,
): ImportedCookie | "expired" | null {
  const name = typeof f.name === "string" ? f.name : f.name == null ? "" : String(f.name);
  let domain = String(f.domain ?? "").trim().toLowerCase();
  if (!name.trim() || !domain || /[\s/]/.test(domain)) return null;
  const secure = truthy(f.secure) || name.startsWith("__Secure-") || name.startsWith("__Host-");
  const path = typeof f.path === "string" && f.path.startsWith("/") ? f.path : "/";
  const c: ImportedCookie = { name, value: f.value == null ? "" : String(f.value), path, secure, httpOnly: truthy(f.httpOnly) };
  // A leading dot means "and its subdomains"; so does hostOnly:false from the extensions' format.
  const hostOnly = f.hostOnly === undefined ? !domain.startsWith(".") : truthy(f.hostOnly);
  domain = domain.replace(/^\.+/, "");
  if (hostOnly || name.startsWith("__Host-")) c.url = `${secure ? "https" : "http"}://${domain}${path}`;
  else c.domain = `.${domain}`;
  const ss = SAME_SITE[String(f.sameSite ?? "").trim().toLowerCase()];
  // SameSite=None without Secure is refused by Chrome; leaving it out gives the browser's default (Lax).
  if (ss && !(ss === "None" && !secure)) c.sameSite = ss;
  if (!truthy(f.session)) {
    const raw = Number(f.expires);
    if (Number.isFinite(raw) && raw > 0) {
      // Milliseconds from tools that write Date.now()-style values.
      const sec = raw > 1e11 ? raw / 1000 : raw;
      if (sec <= now) return "expired";
      c.expires = Math.floor(sec);
    }
  }
  return c;
}

function cookieFromObject(o: Record<string, unknown>, now: number) {
  return makeCookie(
    {
      name: o.name ?? o.Name ?? o.key,
      value: o.value ?? o.Value,
      domain: o.domain ?? o.Domain ?? o.host ?? o.host_key,
      path: o.path ?? o.Path,
      secure: o.secure ?? o.Secure ?? o.is_secure,
      httpOnly: o.httpOnly ?? o.HttpOnly ?? o.httponly ?? o.is_httponly,
      sameSite: o.sameSite ?? o.SameSite ?? o.samesite,
      expires: o.expirationDate ?? o.expires ?? o.Expires ?? o.expiry ?? o.expires_utc,
      hostOnly: o.hostOnly,
      session: o.session,
    },
    now,
  );
}

const looksLikeCookie = (o: unknown): o is Record<string, unknown> =>
  !!o && typeof o === "object" && !Array.isArray(o) && ("name" in o || "Name" in o) && ("domain" in o || "Domain" in o || "host" in o);

function collect(items: unknown[], now: number): CookieParse {
  const out: CookieParse = { cookies: [], skipped: 0, expired: 0 };
  for (const it of items) {
    const c = looksLikeCookie(it) ? cookieFromObject(it, now) : null;
    if (c === "expired") out.expired++;
    else if (c) out.cookies.push(c);
    else out.skipped++;
  }
  return out;
}

/** Netscape cookies.txt: domain, subdomains, path, secure, expiry, name, value — tab separated. */
function parseNetscape(text: string, now: number): CookieParse {
  const out: CookieParse = { cookies: [], skipped: 0, expired: 0 };
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith("#HttpOnly_")) {
      httpOnly = true;
      line = line.slice("#HttpOnly_".length);
    } else if (!line.trim() || line.startsWith("#")) continue;
    const f = line.split("\t");
    if (f.length < 7) {
      out.skipped++;
      continue;
    }
    const c = makeCookie(
      {
        domain: f[0],
        hostOnly: !truthy(f[1]),
        path: f[2],
        secure: f[3],
        expires: f[4],
        name: f[5],
        value: f.slice(6).join("\t"),
        httpOnly,
      },
      now,
    );
    if (c === "expired") out.expired++;
    else if (c) out.cookies.push(c);
    else out.skipped++;
  }
  return out;
}

/** The cookie list inside a parsed JSON value: an array, or an object holding one. */
function cookieArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of ["cookies", "cookie", "Cookies", "data"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner;
    }
  }
  return null;
}

/**
 * Read cookies from any of the usual formats: a JSON array (or an object holding one, or a string of
 * either, as exports put in a cell) or Netscape cookies.txt. Unknown text gives no cookies, not an error.
 */
export function parseCookies(input: unknown, now = Date.now() / 1000): CookieParse {
  if (Array.isArray(input) || (input && typeof input === "object")) {
    const arr = cookieArray(input);
    return arr ? collect(arr, now) : { cookies: [], skipped: 0, expired: 0 };
  }
  const text = String(input ?? "").replace(/^﻿/, "").trim();
  if (!text) return { cookies: [], skipped: 0, expired: 0 };
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      return parseCookies(JSON.parse(text), now);
    } catch {
      return { cookies: [], skipped: 1, expired: 0 };
    }
  }
  return parseNetscape(text, now);
}

/** Same name, domain and path is the same cookie: the later one wins. */
export function mergeCookies(a: ImportedCookie[], b: ImportedCookie[]): ImportedCookie[] {
  const key = (c: ImportedCookie) => `${c.name}\u0000${c.domain ?? c.url?.replace(/^https?:\/\/([^/]+).*$/, "$1")}\u0000${c.path}`;
  const m = new Map<string, ImportedCookie>();
  for (const c of [...a, ...b]) m.set(key(c), c);
  return [...m.values()];
}

// ── profile lists ───────────────────────────────────────────────────────────────────────────────

/** Field names compared without case, spaces, dashes or underscores: "Proxy Host" = proxy_host = proxyHost. */
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES = {
  name: ["name", "profilename", "profile", "title", "browsername", "accountname", "account"],
  notes: ["notes", "note", "remark", "remarks", "description", "comment", "comments"],
  tags: ["tags", "tag", "labels", "label"],
  group: ["group", "groupname", "folder", "foldername", "category"],
  proxy: ["proxy", "proxyurl", "proxystring"],
  proxyType: ["proxytype", "proxyprotocol", "proxymode", "proxyscheme"],
  proxyHost: ["proxyhost", "proxyip", "proxyserver", "proxyaddress", "host", "ip"],
  proxyPort: ["proxyport", "port"],
  proxyUser: ["proxyuser", "proxyusername", "proxylogin", "username", "login", "user"],
  proxyPass: ["proxypassword", "proxypass", "password", "pass"],
  cookies: ["cookies", "cookie", "cookiejson"],
  userAgent: ["useragent", "ua"],
  os: ["os", "platform", "ostype", "system"],
  // AdsPower exports it as fakey ("2FA key"); others as 2fa, totp, otp secret…
  totp: ["fakey", "2fakey", "2fa", "2fasecret", "totp", "totpsecret", "totpkey", "otpsecret", "otpkey", "twofactor", "twofactorsecret", "authenticatorkey", "mfasecret"],
};

function pick(row: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (row[n] !== undefined && row[n] !== null && row[n] !== "") return row[n];
  return undefined;
}

/** Keys normalised, and the usual nested objects (navigator, proxy) flattened one level. */
function flatten(o: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const nk = norm(k);
    if (row[nk] === undefined) row[nk] = v;
    // GoLogin's navigator.userAgent, Multilogin's fingerprint.navigator…
    if (v && typeof v === "object" && !Array.isArray(v) && (nk === "navigator" || nk === "fingerprint")) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        const nk2 = norm(k2);
        if (row[nk2] === undefined) row[nk2] = v2;
        if (v2 && typeof v2 === "object" && norm(k2) === "navigator") {
          for (const [k3, v3] of Object.entries(v2 as Record<string, unknown>)) if (row[norm(k3)] === undefined) row[norm(k3)] = v3;
        }
      }
    }
  }
  return row;
}

const str = (v: unknown) => (v == null ? "" : typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** A proxy given as a string, as an object ({type, host, port, login, password}), or as columns. */
function readProxy(row: Record<string, unknown>): { proxy?: string; unreadable?: string } {
  const p = pick(row, ALIASES.proxy);
  if (p && typeof p === "object" && !Array.isArray(p)) {
    const o = flatten(p as Record<string, unknown>);
    const mode = str(pick(o, ["type", "mode", "protocol", "scheme", ...ALIASES.proxyType])).toLowerCase();
    if (mode === "none" || mode === "noproxy" || mode === "direct") return {};
    return fromParts(
      mode,
      str(pick(o, ["host", "ip", "server", "address", ...ALIASES.proxyHost])),
      str(pick(o, ["port", ...ALIASES.proxyPort])),
      str(pick(o, ["login", "username", "user", ...ALIASES.proxyUser])),
      str(pick(o, ["password", "pass", ...ALIASES.proxyPass])),
    );
  }
  const s = str(p);
  if (s) {
    if (/^(none|no proxy|noproxy|direct|-)$/i.test(s)) return {};
    const n = normalizeProxy(s);
    return n ? { proxy: n } : { unreadable: s };
  }
  const host = str(pick(row, ALIASES.proxyHost));
  if (!host) return {};
  return fromParts(
    str(pick(row, ALIASES.proxyType)).toLowerCase(),
    host,
    str(pick(row, ALIASES.proxyPort)),
    str(pick(row, ALIASES.proxyUser)),
    str(pick(row, ALIASES.proxyPass)),
  );
}

function fromParts(mode: string, host: string, port: string, user: string, pass: string): { proxy?: string; unreadable?: string } {
  if (!host) return {};
  const scheme = /socks5|socks/.test(mode) ? "socks5" : /https/.test(mode) ? "https" : "http";
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : "";
  const raw = `${scheme}://${auth}${host}${port ? `:${port}` : ""}`;
  const n = normalizeProxy(raw);
  return n ? { proxy: n } : { unreadable: `${host}${port ? `:${port}` : ""}` };
}

/** The OS family, from an explicit os/platform field first, else the old user-agent. */
export function platformOf(os: string, ua: string): MigratedProfile["platform"] {
  const o = os.toLowerCase();
  if (/^(win|windows)/.test(o)) return "windows";
  if (/^(mac|macos|osx|darwin)/.test(o)) return "macos";
  if (/^(lin|linux|ubuntu)/.test(o)) return "linux";
  if (/^android/.test(o)) return "android";
  if (/Android/i.test(ua)) return "android";
  if (/Windows NT/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return undefined;
}

function splitList(v: unknown): string[] {
  const items = Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? str((x as { name?: unknown }).name) : str(x))) : str(v).split(/[,;|]/);
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))];
}

function profileFromRow(o: Record<string, unknown>, i: number, now: number, warn: (s: string) => void): MigratedProfile | null {
  const row = flatten(o);
  const name = str(pick(row, ALIASES.name)) || `Imported ${i + 1}`;
  const { proxy, unreadable } = readProxy(row);
  if (unreadable) warn(`“${name}”: the proxy “${unreadable}” could not be read, so it was left out.`);
  const c = pick(row, ALIASES.cookies);
  const jar = c === undefined ? { cookies: [], skipped: 0, expired: 0 } : parseCookies(c, now);
  if (jar.skipped) warn(`“${name}”: ${jar.skipped} cookie entr${jar.skipped === 1 ? "y" : "ies"} could not be read.`);
  const notes = str(pick(row, ALIASES.notes));
  const tags = splitList(pick(row, ALIASES.tags));
  const groupRaw = pick(row, ALIASES.group);
  const group = groupRaw && typeof groupRaw === "object" && !Array.isArray(groupRaw) ? str((groupRaw as { name?: unknown }).name) : str(groupRaw);
  const platform = platformOf(str(pick(row, ALIASES.os)), str(pick(row, ALIASES.userAgent)));
  const totpRaw = str(pick(row, ALIASES.totp));
  const totp = totpRaw && parseTotp(totpRaw).ok ? totpRaw : undefined;
  if (totpRaw && !totp) warn(`“${name}”: its 2FA key could not be read, so it was left out.`);
  const hasData = !!(proxy || jar.cookies.length || notes || tags.length || str(pick(row, ALIASES.name)));
  if (!hasData) return null;
  return {
    name,
    ...(notes ? { notes } : {}),
    ...(tags.length ? { tags } : {}),
    ...(group ? { group } : {}),
    ...(proxy ? { proxy } : {}),
    ...(platform ? { platform } : {}),
    ...(totp ? { totp } : {}),
    cookies: jar.cookies,
  };
}

/** RFC 4180-ish: quoted fields, doubled quotes, newlines inside quotes. Delimiter guessed from the header. */
export function parseDelimited(text: string): Record<string, string>[] {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const counts = [",", ";", "\t"].map((d) => [d, firstLine.split(d).length] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"' && field === "") q = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ""])));
}

/** The list of profile objects inside a parsed JSON export. */
function profileArray(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") {
    for (const k of ["profiles", "data", "list", "items", "browsers", "result"]) {
      const inner = (v as Record<string, unknown>)[k];
      if (Array.isArray(inner)) return inner;
      if (inner && typeof inner === "object") {
        const deeper = profileArray(inner);
        if (deeper) return deeper;
      }
    }
    return [v];
  }
  return null;
}

/**
 * Read another browser's export into profiles to create. A file that is only cookies becomes one profile
 * named after the file. Throws only when the file cannot be read at all.
 */
export function parseMigration(text: string, filename = "", nowSec = Date.now() / 1000): MigrationParse {
  const warnings: string[] = [];
  const warn = (s: string) => warnings.push(s);
  const body = String(text ?? "").replace(/^﻿/, "").trim();
  if (!body) throw new Error("The file is empty.");
  if (/^PK\x03\x04/.test(body) || /\.xlsx?$/i.test(filename)) {
    throw new Error("Excel files can't be read directly. Open it in Excel or Google Sheets and save it as CSV, then import the CSV.");
  }
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Imported";

  let rows: unknown[];
  if (body.startsWith("[") || body.startsWith("{")) {
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new Error("The file looks like JSON but could not be read.");
    }
    // A cookie export, not a profile list: one profile holding those cookies.
    const arr = cookieArray(data);
    if (arr && arr.length && arr.every(looksLikeCookie)) {
      const jar = collect(arr, nowSec);
      return { profiles: [{ name: base, cookies: jar.cookies }], skipped: 0, cookies: jar.cookies.length, warnings };
    }
    rows = profileArray(data) ?? [];
  } else if (/^#|\t(TRUE|FALSE)\t/im.test(body.split(/\r?\n/).slice(0, 5).join("\n"))) {
    const jar = parseNetscape(body, nowSec);
    if (jar.cookies.length) return { profiles: [{ name: base, cookies: jar.cookies }], skipped: 0, cookies: jar.cookies.length, warnings };
    rows = [];
  } else {
    rows = parseDelimited(body);
  }

  const profiles: MigratedProfile[] = [];
  let skipped = 0;
  rows.forEach((r, i) => {
    const p = r && typeof r === "object" && !Array.isArray(r) ? profileFromRow(r as Record<string, unknown>, i, nowSec, warn) : null;
    if (p) profiles.push(p);
    else skipped++;
  });
  if (!profiles.length) throw new Error("No profiles were found in this file.");
  return { profiles, skipped, cookies: profiles.reduce((n, p) => n + p.cookies.length, 0), warnings };
}
