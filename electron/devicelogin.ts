// "Use my Clearcote account": get the licence key by signing in on clearcotelabs.com instead of pasting it.
//
// The site's device sign-in (RFC 8628), the same one `clearcote login` uses:
//   POST {base}/api/v1/device/code   {client_name, client_version}
//     -> {device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval}
//   the person opens verification_uri_complete (/activate?code=…), is signed in, checks and approves
//   POST {base}/api/v1/device/token  {device_code}   (every `interval` seconds)
//     -> 200 {license_key, plan, expires_at, account_email?}   once, after approval
//     -> 400 {error: authorization_pending | slow_down | expired_token | access_denied | invalid_request}
//
// The device_code and the key stay in this process. The window (or the web page) gets an id to poll with,
// the code to compare, and the address to open; on approval the key goes straight into settings.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEVICE_CLIENT_NAME = "clearcote-profile-manager";

const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version as string;
  } catch {
    return undefined;
  }
})();

interface Pending {
  base: string;
  deviceCode: string;
  intervalMs: number;
  expiresAt: number;
  lastPollAt: number;
}

const pending = new Map<string, Pending>();

export type LoginStart =
  | { ok: true; id: string; userCode: string; verificationUri: string; expiresIn: number; interval: number }
  | { ok: false; error: string };

export type LoginPoll =
  | { status: "pending" }
  | { status: "approved"; key: string; plan?: string; account?: string; expiresAt?: string | null }
  | { status: "denied" | "expired"; error: string }
  | { status: "error"; error: string };

type Fetch = typeof fetch;

async function post(f: Fetch, url: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await f(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": `${DEVICE_CLIENT_NAME}/${VERSION ?? "unknown"}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await r.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: parsed };
}

/** Start a sign-in. The address to open must be on the same site the code came from. */
export async function startLogin(base: string, f: Fetch = fetch, now = Date.now()): Promise<LoginStart> {
  for (const [id, p] of pending) if (p.expiresAt < now) pending.delete(id);
  let r;
  try {
    r = await post(f, `${base}/api/v1/device/code`, { client_name: DEVICE_CLIENT_NAME, ...(VERSION ? { client_version: VERSION } : {}) });
  } catch (e) {
    return { ok: false, error: `Could not reach ${new URL(base).host}: ${(e as Error).message}` };
  }
  if (r.status === 429) return { ok: false, error: "Too many sign-ins from this network. Try again in ten minutes." };
  const b = r.body;
  if (r.status !== 200 || typeof b.device_code !== "string" || typeof b.user_code !== "string") {
    return { ok: false, error: `The sign-in could not start (${r.status}${b.error ? `, ${b.error}` : ""}).` };
  }
  const uri = String(b.verification_uri_complete || b.verification_uri || "");
  // The person is sent there to sign in: only the site that issued the code, over https (or a local test server).
  let sameSite = false;
  try {
    const u = new URL(uri);
    sameSite = u.origin === new URL(base).origin && (u.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(u.hostname));
  } catch {
    /* not a URL */
  }
  if (!sameSite) return { ok: false, error: "The sign-in answer pointed somewhere unexpected." };
  const id = crypto.randomBytes(12).toString("base64url");
  const intervalMs = Math.max(1, Number(b.interval) || 5) * 1000;
  const expiresIn = Number(b.expires_in) || 600;
  pending.set(id, { base, deviceCode: b.device_code, intervalMs, expiresAt: now + expiresIn * 1000, lastPollAt: 0 });
  return { ok: true, id, userCode: b.user_code, verificationUri: uri, expiresIn, interval: intervalMs / 1000 };
}

/** One look: has the person approved yet? Polling sooner than the site allows just answers "pending". */
export async function pollLogin(id: string, f: Fetch = fetch, now = Date.now()): Promise<LoginPoll> {
  const p = pending.get(String(id));
  if (!p || p.expiresAt < now) {
    pending.delete(String(id));
    return { status: "expired", error: "The sign-in expired. Start it again." };
  }
  if (now - p.lastPollAt < p.intervalMs) return { status: "pending" };
  p.lastPollAt = now;
  let r;
  try {
    r = await post(f, `${p.base}/api/v1/device/token`, { device_code: p.deviceCode });
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
  const b = r.body;
  if (r.status === 200 && typeof b.license_key === "string") {
    pending.delete(String(id));
    return {
      status: "approved",
      key: b.license_key,
      plan: typeof b.plan === "string" ? b.plan : undefined,
      account: typeof b.account_email === "string" ? b.account_email : undefined,
      expiresAt: typeof b.expires_at === "string" ? b.expires_at : null,
    };
  }
  switch (b.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      p.intervalMs += 5000;
      return { status: "pending" };
    case "access_denied":
      pending.delete(String(id));
      return {
        status: "denied",
        error: "Not approved, or this account has no key that can be handed out. The dashboard's Licenses page has your keys.",
      };
    case "expired_token":
      pending.delete(String(id));
      return { status: "expired", error: "The sign-in expired. Start it again." };
    default:
      return { status: "error", error: `The site answered ${r.status}${b.error ? ` (${b.error})` : ""}.` };
  }
}

/** For tests. */
export function _resetLogins() {
  pending.clear();
}
