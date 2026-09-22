// Floating-concurrency licensing client for the profile manager (opt-in PRO).
//
// Vendored from the clearcote Node SDK (sdk/node/src/license.ts) so the Electron
// main process stays CommonJS + dependency-free (node stdlib + global fetch only,
// no playwright). When a license key is configured the launcher checks out one of
// the license's N concurrency slots, receives a short-lived Ed25519 run-token, and
// spawns the PRO browser with CLEARCOTE_RUN_TOKEN set — the gated build refuses to
// launch without it. With no key this whole module is inert (free mode).

import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_API_BASE = "https://www.clearcotelabs.com";
const RUN_TOKEN_ENV = "CLEARCOTE_RUN_TOKEN";
/** Points the engine at a file it re-reads while the browser runs (see {@link LeaseSession.bindLaunch}). */
export const RUN_TOKEN_FILE_ENV = "CLEARCOTE_RUN_TOKEN_FILE";

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
    // A per-browser (free-tier) token belongs to the one browser it was checked out for; offline
    // grace on it would start a browser without a slot. Paid tokens keep their offline grace.
    if (d && typeof d.token === "string" && typeof d.exp === "number" && planFromToken(d.token) !== PER_BROWSER_PLAN) return d;
  } catch {
    /* ignore */
  }
  return null;
}

/** The plan whose tokens are per browser (the GitHub free tier). */
const PER_BROWSER_PLAN = "free";

/** One id per browser launch: the backend counts every launch_id as its own slot on per-browser plans. */
export function newLaunchId(): string {
  return randomUUID().replace(/-/g, "");
}

function writeCache(licenseKey: string, token: string, exp: number): void {
  if (planFromToken(token) === PER_BROWSER_PLAN) return; // never cache a per-browser token
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
  /**
   * Mirror this lease's rotating run-token into a file for one launch (CLEARCOTE_RUN_TOKEN_FILE).
   * A supporting engine (152 r23+) re-reads it and stops a running FREE browser once the token
   * stops advancing, so revoke / check-in / over-limit reach a browser that is already open — and a
   * free launch WITHOUT the file is refused by the engine. Older engines ignore it, so binding is
   * always safe. Call `release()` when that browser closes.
   */
  bindLaunch(): { path: string; release: () => void };
  /** Release the slot + stop the heartbeat (best-effort; safe to call twice — every caller awaits
   *  the same check-in). */
  stop(): Promise<void>;
  /** Set while the server refuses heartbeats (revoked, over the limit…); cleared by the next OK. */
  readonly refusal?: LeaseRefusal;
}

/** Why the licence server last refused to renew a lease. */
export interface LeaseRefusal {
  status: number;
  code?: string;
  error?: string;
}

/** Per-launch run-token files that follow one lease's rotation. Every write is best-effort: the
 * launch still carries CLEARCOTE_RUN_TOKEN, so a failure here never stops a browser starting. */
class TokenFileSet {
  private paths = new Set<string>();

  bind(current: string): { path: string; release: () => void } {
    const path = join(tmpdir(), `clearcote-rt-${randomUUID()}.tok`);
    this.write(path, current);
    this.paths.add(path);
    return {
      path,
      release: () => {
        this.paths.delete(path);
        try {
          rmSync(path, { force: true });
        } catch {
          /* already gone */
        }
      },
    };
  }

  /** Rewrite every live file with the freshly-rotated token. */
  update(token: string): void {
    for (const p of this.paths) this.write(p, token);
  }

  closeAll(): void {
    for (const p of this.paths) {
      try {
        rmSync(p, { force: true });
      } catch {
        /* already gone */
      }
    }
    this.paths.clear();
  }

  private write(path: string, token: string): void {
    try {
      writeFileSync(path, token, { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }
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
  // This launch's id. The launcher already takes one lease per browser; sending launch_id lets the
  // backend count it that way on per-browser plans (the free tier), and a re-checkout below re-uses it.
  const launchId = newLaunchId();
  const warn = (m: string) => {
    if (!opts.quiet) process.stderr.write(`[clearcote] [license] ${m}\n`);
  };

  let checkout: CheckoutResponse;
  try {
    const res = await postJson(`${base}/api/v1/lease/checkout`, licenseKey, {
      instance_id: instanceId,
      launch_id: launchId,
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
      // Offline grace is paid-only (readCache refuses per-browser tokens), and the cached token
      // never rotates — bind it anyway so the engine sees the file and the launch is consistent.
      const files = new TokenFileSet();
      return {
        token: cached.token,
        leaseId: "cached",
        bindLaunch: () => files.bind(cached.token),
        stop: async () => files.closeAll(),
      };
    }
    throw new LicenseError(`Could not reach the license server and no valid cached token: ${String(e)}`);
  }

  let leaseId = checkout.lease_id;
  let currentToken = checkout.token;
  const tokenFiles = new TokenFileSet();
  // One place that advances the token, so every rotation (heartbeat AND the 409 re-checkout below)
  // reaches the bound files. A token that stops advancing is exactly what the engine stops on.
  const setToken = (t: string) => {
    currentToken = t;
    tokenFiles.update(t);
  };
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
          launch_id: launchId,
          os: osTag(),
          sdk_version: opts.sdkVersion,
        });
        if (co.ok) {
          const data = (await co.json()) as CheckoutResponse;
          leaseId = data.lease_id;
          setToken(data.token);
          writeCache(licenseKey, data.token, data.exp);
          refusal = undefined;
        } else {
          const body = (await co.json().catch(() => ({}))) as { error?: string; code?: string };
          refusal = { status: co.status, code: body.code, error: body.error };
        }
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as { token: string; exp: number };
        setToken(data.token);
        writeCache(licenseKey, data.token, data.exp);
        refusal = undefined;
      } else {
        // The token stops advancing now, and a FREE engine will stop its browser once its grace
        // runs out. Keep the server's reason, so the card can say WHY the browser closed.
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
        refusal = { status: res.status, code: body.code, error: body.error };
      }
    } catch {
      /* transient — offline grace until token exp */
    }
  }, hbMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  let refusal: LeaseRefusal | undefined;
  // One check-in, shared: every caller of stop() awaits the SAME request, so "stop this browser,
  // then launch that one" really waits until the server has the slot back.
  let stopping: Promise<void> | null = null;
  const stop = () => {
    if (!stopping) {
      clearInterval(timer);
      tokenFiles.closeAll();
      stopping = postJson(`${base}/api/v1/lease/checkin`, licenseKey, { lease_id: leaseId }).then(
        () => undefined,
        () => undefined, // best-effort; the lease TTL will reclaim it anyway
      );
    }
    return stopping;
  };

  return {
    get token() {
      return currentToken;
    },
    get refusal() {
      return refusal;
    },
    leaseId,
    bindLaunch: () => tokenFiles.bind(currentToken),
    stop,
  } as LeaseSession;
}

export interface LicenseStatus {
  ok: boolean;
  /** Valid, but every browser slot is in use right now (the check could not take one). */
  busy?: boolean;
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
      launch_id: newLaunchId(),
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
    // Refused for being AT its browser limit is still a verdict on the key: it is valid and live,
    // every slot is just in use (a free key with its one browser open). Say that, instead of the
    // "check failed" this used to report whenever a profile was running.
    if (res.status === 429 || body.code === "CONCURRENCY_LIMIT_EXCEEDED") {
      return { ok: true, busy: true, code: body.code, used: body.concurrency?.used, limit: body.concurrency?.limit };
    }
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
  tokenFile?: string,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env) };
  out[RUN_TOKEN_ENV] = token;
  // Opt in to engine-side online enforcement when a refreshable file is bound. Without it a FREE
  // licence is refused by a supporting engine, because nothing could stop the browser later.
  if (tokenFile) out[RUN_TOKEN_FILE_ENV] = tokenFile;
  return out;
}
