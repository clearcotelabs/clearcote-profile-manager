// Floating-concurrency licensing client for the profile manager (opt-in PRO).
//
// Vendored from the clearcote Node SDK (sdk/node/src/license.ts) so the Electron
// main process stays CommonJS + dependency-free (node stdlib + global fetch only,
// no playwright). When a license key is configured the launcher checks out one of
// the license's N concurrency slots, receives a short-lived Ed25519 run-token, and
// spawns the PRO browser with CLEARCOTE_RUN_TOKEN set — the gated build refuses to
// launch without it. With no key this whole module is inert (free mode).

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_API_BASE = "https://www.clearcotelabs.com";
const RUN_TOKEN_ENV = "CLEARCOTE_RUN_TOKEN";

export class LicenseError extends Error {
  code: string;
  constructor(message: string, code = "LICENSE_ERROR") {
    super(message);
    this.name = "LicenseError";
    this.code = code;
  }
}
export class ConcurrencyLimitError extends LicenseError {
  constructor(message: string) {
    super(message, "CONCURRENCY_LIMIT_EXCEEDED");
    this.name = "ConcurrencyLimitError";
  }
}
export class LicenseRevokedError extends LicenseError {
  constructor(message: string) {
    super(message, "LICENSE_REVOKED");
    this.name = "LicenseRevokedError";
  }
}

/** Resolve a license key: explicit > CLEARCOTE_LICENSE_KEY env > ~/.clearcote/license.key. */
export function resolveLicenseKey(explicit?: string): string | undefined {
  if (explicit && explicit.trim()) return explicit.trim();
  const env = process.env.CLEARCOTE_LICENSE_KEY;
  if (env && env.trim()) return env.trim();
  try {
    const p = join(homedir(), ".clearcote", "license.key");
    if (existsSync(p)) {
      const v = readFileSync(p, "utf8").trim();
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function apiBase(explicit?: string): string {
  return (explicit || process.env.CLEARCOTE_LICENSE_API || DEFAULT_API_BASE).replace(/\/$/, "");
}

const osTag = (): string =>
  (({ win32: "windows", linux: "linux", darwin: "macos" } as Record<string, string>)[process.platform] ??
    "unknown");

// ── offline token cache (best-effort grace) ───────────────────────────────
function cachePath(licenseKey: string): string {
  const id = createHash("sha256").update(licenseKey).digest("hex").slice(0, 16);
  return join(homedir(), ".clearcote", `lease-${id}.json`);
}
function readCache(licenseKey: string): { token: string; exp: number } | null {
  try {
    const d = JSON.parse(readFileSync(cachePath(licenseKey), "utf8"));
    if (d && typeof d.token === "string" && typeof d.exp === "number") return d;
  } catch {
    /* ignore */
  }
  return null;
}
function writeCache(licenseKey: string, token: string, exp: number): void {
  try {
    mkdirSync(join(homedir(), ".clearcote"), { recursive: true });
    writeFileSync(cachePath(licenseKey), JSON.stringify({ token, exp }));
  } catch {
    /* ignore */
  }
}

interface CheckoutResponse {
  lease_id: string;
  token: string;
  exp: number;
  lease_ttl_sec: number;
  heartbeat_interval_sec: number;
  concurrency: { used: number; limit: number };
}

async function postJson(url: string, licenseKey: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${licenseKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function throwForStatus(status: number, body: { error?: string; code?: string }): never {
  const msg = body?.error || `License request failed (${status}).`;
  if (status === 429 || body?.code === "CONCURRENCY_LIMIT_EXCEEDED") throw new ConcurrencyLimitError(msg);
  if (status === 403 || body?.code === "LICENSE_REVOKED" || body?.code === "LICENSE_EXPIRED")
    throw new LicenseRevokedError(msg);
  throw new LicenseError(msg, body?.code || `HTTP_${status}`);
}

/** Decode the `plan` claim out of a run-token (base64url payload.sig) without verifying it. */
export function planFromToken(token: string): string | undefined {
  try {
    const body = token.split(".")[0];
    const json = Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const p = JSON.parse(json) as { plan?: string };
    return p.plan;
  } catch {
    return undefined;
  }
}

/** A live lease. Keep it until the browser closes, then call `stop()`. */
export interface LeaseSession {
  token: string;
  leaseId: string;
  /** Release the slot + stop the heartbeat (best-effort; safe to call twice). */
  stop(): Promise<void>;
}

/**
 * Acquire a concurrency lease if a license key is given. Returns `null` when no
 * key (free mode). Throws {@link ConcurrencyLimitError}/{@link LicenseRevokedError}/
 * {@link LicenseError} when a key IS present but the backend refuses. On a network
 * failure with a still-valid cached token, resumes offline (degraded).
 */
export async function acquireLease(opts: {
  licenseKey?: string;
  licenseApiBase?: string;
  sdkVersion?: string;
  quiet?: boolean;
}): Promise<LeaseSession | null> {
  const licenseKey = resolveLicenseKey(opts.licenseKey);
  if (!licenseKey) return null; // free mode — inert

  const base = apiBase(opts.licenseApiBase);
  const instanceId = randomUUID();
  const warn = (m: string) => {
    if (!opts.quiet) process.stderr.write(`[clearcote] [license] ${m}\n`);
  };

  let checkout: CheckoutResponse;
  try {
    const res = await postJson(`${base}/api/v1/lease/checkout`, licenseKey, {
      instance_id: instanceId,
      os: osTag(),
      sdk_version: opts.sdkVersion,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      throwForStatus(res.status, body);
    }
    checkout = (await res.json()) as CheckoutResponse;
    writeCache(licenseKey, checkout.token, checkout.exp);
  } catch (e) {
    if (e instanceof LicenseError) throw e; // a definitive verdict must surface
    const cached = readCache(licenseKey);
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp > now + 60) {
      warn(`backend unreachable (${String(e)}); using cached run-token (offline grace).`);
      return { token: cached.token, leaseId: "cached", stop: async () => {} };
    }
    throw new LicenseError(`Could not reach the license server and no valid cached token: ${String(e)}`);
  }

  let leaseId = checkout.lease_id;
  let currentToken = checkout.token;
  const hbMs = Math.max(5, checkout.heartbeat_interval_sec || 30) * 1000;

  const timer = setInterval(async () => {
    try {
      const res = await postJson(`${base}/api/v1/lease/heartbeat`, licenseKey, {
        lease_id: leaseId,
        nonce: randomUUID(),
      });
      if (res.status === 409) {
        const co = await postJson(`${base}/api/v1/lease/checkout`, licenseKey, {
          instance_id: instanceId,
          os: osTag(),
          sdk_version: opts.sdkVersion,
        });
        if (co.ok) {
          const data = (await co.json()) as CheckoutResponse;
          leaseId = data.lease_id;
          currentToken = data.token;
          writeCache(licenseKey, data.token, data.exp);
        }
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { token: string; exp: number };
        currentToken = data.token;
        writeCache(licenseKey, data.token, data.exp);
      }
    } catch {
      /* transient — offline grace until token exp */
    }
  }, hbMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    try {
      await postJson(`${base}/api/v1/lease/checkin`, licenseKey, { lease_id: leaseId });
    } catch {
      /* best-effort; the lease TTL will reclaim it anyway */
    }
  };

  return {
    get token() {
      return currentToken;
    },
    leaseId,
    stop,
  } as LeaseSession;
}

export interface LicenseStatus {
  ok: boolean;
  plan?: string;
  used?: number;
  limit?: number;
  error?: string;
  code?: string;
}

/**
 * Validate a license key for the Settings UI: check out a slot, read its plan +
 * concurrency, then immediately check the slot back in so this probe never holds
 * a seat. Never throws — returns a {@link LicenseStatus} either way.
 */
export async function checkLicense(licenseKey?: string, licenseApiBase?: string): Promise<LicenseStatus> {
  const key = resolveLicenseKey(licenseKey);
  if (!key) return { ok: false, error: "No license key set." };
  const base = apiBase(licenseApiBase);
  try {
    const res = await postJson(`${base}/api/v1/lease/checkout`, key, {
      instance_id: randomUUID(),
      os: osTag(),
      sdk_version: "profile-manager",
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
      lease_id?: string;
      token?: string;
      concurrency?: { used: number; limit: number };
    };
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}`, code: body.code };
    // release the probe slot right away (best-effort)
    if (body.lease_id) await postJson(`${base}/api/v1/lease/checkin`, key, { lease_id: body.lease_id }).catch(() => {});
    return {
      ok: true,
      plan: body.token ? planFromToken(body.token) : undefined,
      used: body.concurrency?.used,
      limit: body.concurrency?.limit,
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Merge the run-token into a child-process env (base defaults to the parent env). */
export function withRunToken(
  token: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  out[RUN_TOKEN_ENV] = token;
  return out;
}
