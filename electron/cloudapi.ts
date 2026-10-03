// The hosted-browser API as this app uses it: the account (balance), starting a session, reading it,
// stopping it, and the live view. Authenticated with the account's API key (cc_live_…), which is a
// different thing from the licence key: the licence runs browsers on this PC, the API key pays for
// browsers on Clearcote's servers.
//
// Every call answers { ok, data } or { ok:false, status, code, error } and never throws, so the main
// process can hand the result straight to the window. The key only ever leaves in the Authorization
// header, and only to an https:// base (or this machine, for tests), the same rule as the SDKs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_CLOUD_BASE = "https://www.clearcotelabs.com";
const SID_RE = /^bs_[A-Za-z0-9_-]{16,64}$/;

/** Names the app and its version, like the licence calls, so the service's logs can tell them apart. */
export const CLOUD_USER_AGENT = `clearcote-profile-manager/${(() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "unknown";
  }
})()}`;

/** The saved key, else CLEARCOTE_API_KEY (what the SDKs read). */
export function resolveApiKey(saved?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const s = saved?.trim() || env.CLEARCOTE_API_KEY?.trim();
  return s || undefined;
}

/**
 * Where the API lives: CLEARCOTE_API_URL (what the SDKs read), else the saved override, else
 * clearcotelabs.com. Only https, except plain http to this machine: the key must never cross a
 * network unencrypted.
 */
export function resolveApiBase(saved?: string, env: NodeJS.ProcessEnv = process.env): { ok: true; base: string } | { ok: false; error: string } {
  const raw = (env.CLEARCOTE_API_URL?.trim() || saved?.trim() || DEFAULT_CLOUD_BASE).replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `The cloud API address “${raw}” is not a URL.` };
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    return { ok: false, error: `The cloud API address must start with https:// (plain http:// only for this machine), not “${raw}”.` };
  }
  return { ok: true, base: raw };
}

export type CloudResult<T> = { ok: true; data: T } | { ok: false; status: number; code?: string; error: string };

export interface CloudAccount {
  balanceEur: number;
  sessions: { id: string; status: string; note?: string | null; createdAt?: string }[];
}

export interface CreatedSession {
  id: string;
  connectUrl: string;
  expiresAt?: string;
  worker?: string;
  warnings?: string[];
  profile?: unknown;
}

export interface SessionView {
  id: string;
  status: string; // pending | active | lost | ended | expired
  createdAt?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  endReason?: string | null;
  /** Someone asked it to stop; its worker closes it on its next report. */
  stopRequested?: boolean;
  usage?: { bytesUp: number; bytesDown: number; seconds: number };
  costEur?: number;
}

export interface LiveView {
  viewUrl: string;
  expiresAt?: string;
  interactive: boolean;
}

export interface CloudApiOptions {
  apiKey: string;
  base: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  userAgent?: string;
}

/** A session status that will not change again. */
export function isFinalStatus(status: string | undefined): boolean {
  return status === "ended" || status === "expired" || status === "lost";
}

export class CloudApi {
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CloudApiOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<CloudResult<T>> {
    const host = (() => {
      try {
        return new URL(this.opts.base).host;
      } catch {
        return this.opts.base;
      }
    })();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.opts.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "user-agent": this.opts.userAgent ?? CLOUD_USER_AGENT,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
        cache: "no-store",
      } as RequestInit);
    } catch (e) {
      const aborted = (e as Error)?.name === "AbortError";
      return {
        ok: false,
        status: 0,
        code: aborted ? "TIMEOUT" : "NETWORK",
        error: aborted ? `${host} did not answer in ${Math.round(this.timeoutMs / 1000)} s.` : `Could not reach ${host}. Check the connection and try again.`,
      };
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text().catch(() => "");
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    if (res.ok) return { ok: true, data: json as T };
    const code = typeof json.code === "string" ? json.code : res.status === 401 ? "UNAUTHORIZED" : undefined;
    const serverError = typeof json.error === "string" && json.error ? json.error : "";
    const error =
      res.status === 401
        ? "The API key was not accepted. Check it in Settings → Cloud."
        : serverError || `${host} answered ${res.status}${res.statusText ? ` ${res.statusText}` : ""}.`;
    return { ok: false, status: res.status, code, error };
  }

  private sid(id: string): CloudResult<never> | null {
    return SID_RE.test(id) ? null : { ok: false, status: 0, code: "BAD_ID", error: `“${id}” is not a cloud session id.` };
  }

  /** The balance and the newest session: what the Settings check shows. */
  account(): Promise<CloudResult<CloudAccount>> {
    return this.call("GET", "/api/v1/browsers?limit=1");
  }

  create(body: Record<string, unknown>): Promise<CloudResult<CreatedSession>> {
    return this.call("POST", "/api/v1/browsers", body);
  }

  async get(id: string): Promise<CloudResult<SessionView>> {
    return this.sid(id) ?? this.call("GET", `/api/v1/browsers/${id}`);
  }

  async stop(id: string): Promise<CloudResult<SessionView>> {
    return this.sid(id) ?? this.call("DELETE", `/api/v1/browsers/${id}`);
  }

  /** A 60-second WebSocket URL for the session's live view; with control, it also takes input. */
  async live(id: string, control: boolean): Promise<CloudResult<LiveView>> {
    return this.sid(id) ?? this.call("GET", `/api/v1/browsers/${id}/live${control ? "?control=1" : ""}`);
  }
}
