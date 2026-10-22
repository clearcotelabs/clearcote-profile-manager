// Who may talk to the helper, and how a web page earns the right to.
//
// Three checks guard every request from a web page (server.ts applies them):
//   1. Host: the request was addressed to 127.0.0.1 / localhost on our port. A page on another site
//      that points its own domain at 127.0.0.1 (DNS rebinding) sends its own name here and is refused.
//   2. Origin: the page is one of ALLOWED_ORIGINS. Browsers set Origin themselves; a page cannot fake it.
//   3. Token: the page was paired. Pairing needs the person at the keyboard to press Approve on the
//      helper's own page (http://127.0.0.1:<port>), which no website can read or click.
// A token is tied to the site that paired it, kept only as a SHA-256 hash, and revocable on that page.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The sites that host the web profile manager. Nothing else can even ask to pair. */
export const DEFAULT_ORIGINS = [
  "https://app.clearcotelabs.com",
  "https://www.clearcotelabs.com",
  "https://clearcotelabs.github.io",
];

/** Allowed origins: the defaults plus any given with --allow-origin / CLEARCOTE_HELPER_ORIGINS
 *  (for running the web UI yourself, e.g. http://localhost:3000). */
export function allowedOrigins(extra: string[] = []): Set<string> {
  const fromEnv = (process.env.CLEARCOTE_HELPER_ORIGINS || "").split(",");
  const out = new Set(DEFAULT_ORIGINS);
  for (const o of [...extra, ...fromEnv]) {
    const n = normalizeOrigin(o);
    if (n) out.add(n);
  }
  return out;
}

/** "https://Example.com/" -> "https://example.com"; null for anything that is not a bare http(s) origin. */
export function normalizeOrigin(o: string): string | null {
  const s = String(o || "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** True when the Host header names this helper (and not some domain resolving to 127.0.0.1). */
export function hostOk(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** The helper's own page, as an Origin. */
export function isLocalOrigin(origin: string | undefined, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

// ── Tokens ────────────────────────────────────────────────────────────────────

export interface PairedSite {
  /** SHA-256 of the token, hex. The token itself is never written down. */
  hash: string;
  origin: string;
  /** What the page called itself ("Chrome on Windows"), shown on the helper's page. */
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export class TokenStore {
  private sites: PairedSite[] = [];
  constructor(private file: string) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(data?.sites)) this.sites = data.sites.filter((s: PairedSite) => s && typeof s.hash === "string");
    } catch {
      /* none yet */
    }
  }

  list(): PairedSite[] {
    return this.sites.map((s) => ({ ...s }));
  }

  /** A new token for `origin`. Returned once; only its hash is kept. */
  issue(origin: string, name: string): string {
    const token = "cch_" + crypto.randomBytes(32).toString("base64url");
    this.sites.push({ hash: sha256(token), origin, name: name.slice(0, 80), createdAt: new Date().toISOString() });
    this.save();
    return token;
  }

  /** The paired site for this token, if the token is real AND was paired by this same origin. */
  check(token: string | undefined, origin: string): PairedSite | null {
    if (!token || !token.startsWith("cch_")) return null;
    const h = sha256(token);
    const site = this.sites.find(
      (s) => s.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(s.hash), Buffer.from(h)) && s.origin === origin,
    );
    if (!site) return null;
    // Written at most once a minute: every request carries the token.
    const now = Date.now();
    if (!site.lastUsedAt || now - Date.parse(site.lastUsedAt) > 60_000) {
      site.lastUsedAt = new Date(now).toISOString();
      this.save();
    }
    return site;
  }

  revoke(hash: string): boolean {
    const before = this.sites.length;
    this.sites = this.sites.filter((s) => s.hash !== hash);
    if (this.sites.length !== before) this.save();
    return this.sites.length !== before;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sites: this.sites }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

// ── Pairing ───────────────────────────────────────────────────────────────────

export type PairStatus = "pending" | "approved" | "denied" | "expired";

export interface Pairing {
  id: string;
  /** Shown on the web page AND on the helper's page; the person checks they match. */
  code: string;
  /** Known only to the page that asked; it must show it to collect the token. */
  secret: string;
  origin: string;
  name: string;
  createdAt: number;
  status: PairStatus;
  token?: string;
}

/** No 0/O, 1/I/L: easy to compare by eye. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function pairingCode(): string {
  let c = "";
  for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

export const PAIRING_TTL_MS = 2 * 60_000;

export class Pairings {
  private all = new Map<string, Pairing>();
  constructor(private now: () => number = Date.now) {}

  /** A new request from `origin`. One open request per site: a new one replaces the old. */
  start(origin: string, name: string): Pairing {
    this.sweep();
    for (const p of this.all.values()) if (p.origin === origin && p.status === "pending") p.status = "expired";
    const p: Pairing = {
      id: crypto.randomBytes(12).toString("base64url"),
      code: pairingCode(),
      secret: crypto.randomBytes(24).toString("base64url"),
      origin,
      name: String(name || "A browser").slice(0, 80),
      createdAt: this.now(),
      status: "pending",
    };
    this.all.set(p.id, p);
    return p;
  }

  get(id: string): Pairing | undefined {
    this.sweep();
    return this.all.get(String(id));
  }

  pending(): Pairing[] {
    this.sweep();
    return [...this.all.values()].filter((p) => p.status === "pending");
  }

  /** The person pressed Approve or Deny on the helper's page. */
  decide(id: string, approve: boolean, issue: (p: Pairing) => string): Pairing | undefined {
    const p = this.get(id);
    if (!p || p.status !== "pending") return undefined;
    p.status = approve ? "approved" : "denied";
    if (approve) p.token = issue(p);
    return p;
  }

  /** What the asking page sees. The token is handed over once, to the holder of the secret. */
  collect(id: string, secret: string): { status: PairStatus; token?: string } | null {
    const p = this.get(id);
    if (!p) return { status: "expired" };
    const a = Buffer.from(String(secret || ""));
    const b = Buffer.from(p.secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (p.status === "approved" && p.token) {
      const token = p.token;
      this.all.delete(p.id);
      return { status: "approved", token };
    }
    return { status: p.status };
  }

  private sweep(): void {
    const t = this.now();
    for (const p of this.all.values()) {
      if (p.status === "pending" && t - p.createdAt > PAIRING_TTL_MS) p.status = "expired";
      if (t - p.createdAt > PAIRING_TTL_MS * 3) this.all.delete(p.id);
    }
  }
}
