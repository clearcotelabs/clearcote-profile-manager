// Two-factor codes (TOTP, RFC 6238) from a profile's 2FA secret: shown live with a copy button, and typed by a task
// through {{otp}}. The secret is what a site shows when 2FA is turned on: base32 text ("JBSW Y3DP …", spaces and case
// don't matter) or the otpauth:// link inside its QR code. Shared by the main process and the window (Web Crypto, which
// both have), so the code on screen and the rules a task runs by are the same. Jet works the code out itself when it
// types it (clearcote_jet/totp.py), so a task gets a code that is valid at that moment, not one from when the run started.

export type TotpAlgorithm = "SHA1" | "SHA256" | "SHA512";

export interface TotpSpec {
  /** Base32, upper case, no spaces or padding. */
  secret: string;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
  /** From an otpauth:// link, for display. */
  issuer?: string;
  account?: string;
}

export type TotpParse = { ok: true; spec: TotpSpec } | { ok: false; error: string };

const ALGORITHMS: Record<TotpAlgorithm, string> = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" };

/** Read a 2FA secret as typed or pasted: base32 text, or an otpauth://totp/… link. */
export function parseTotp(input: string | undefined | null): TotpParse {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, error: "No 2FA secret." };
  let secret = raw;
  let digits = 6;
  let period = 30;
  let algorithm = "SHA1";
  let issuer: string | undefined;
  let account: string | undefined;
  if (/^otpauth:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, error: "That otpauth:// link could not be read." };
    }
    if (u.host.toLowerCase() !== "totp") return { ok: false, error: "Only time-based codes (otpauth://totp/…) are supported." };
    const q = new Map([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    secret = q.get("secret") ?? "";
    digits = Number(q.get("digits") ?? 6);
    period = Number(q.get("period") ?? 30);
    algorithm = (q.get("algorithm") ?? "SHA1").toUpperCase();
    const label = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    const [a, b] = label.includes(":") ? label.split(/:(.*)/s) : [undefined, label];
    issuer = q.get("issuer") || a || undefined;
    account = (b ?? "").trim() || undefined;
  }
  secret = secret.replace(/[\s-]/g, "").toUpperCase().replace(/=+$/, "");
  if (!secret || !/^[A-Z2-7]+$/.test(secret)) return { ok: false, error: "A 2FA secret is base32: letters A–Z and digits 2–7." };
  if (secret.length < 16) return { ok: false, error: "That secret is too short to be a 2FA key (at least 16 characters)." };
  if (!(algorithm in ALGORITHMS)) return { ok: false, error: `Unknown 2FA algorithm ${algorithm}.` };
  if (![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300)) {
    return { ok: false, error: "A 2FA code has 6 to 8 digits and changes every 10 to 300 seconds." };
  }
  return { ok: true, spec: { secret, digits, period, algorithm: algorithm as TotpAlgorithm, ...(issuer ? { issuer } : {}), ...(account ? { account } : {}) } };
}

function base32(secret: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of secret) {
    value = (value << 5) | alphabet.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** The code for one time step (RFC 4226). */
export async function totpAt(spec: TotpSpec, counter: number): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const raw = base32(spec.secret);
  const key = await subtle.importKey("raw", raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer, { name: "HMAC", hash: ALGORITHMS[spec.algorithm] }, false, ["sign"]);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const mac = new Uint8Array(await subtle.sign("HMAC", key, msg));
  const offset = mac[mac.length - 1] & 0x0f;
  const n = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(n % 10 ** spec.digits).padStart(spec.digits, "0");
}

/** The code now and how many seconds it has left. */
export async function totpNow(spec: TotpSpec, nowMs = Date.now()): Promise<{ code: string; secondsLeft: number }> {
  const s = Math.floor(nowMs / 1000);
  return { code: await totpAt(spec, Math.floor(s / spec.period)), secondsLeft: spec.period - (s % spec.period) };
}

/** Seconds before a code's window ends when the next code is used instead (Jet's rule too: clearcote_jet/totp.py LATE). */
export const LATE = 3;

/** The code to type or paste now: this window's, or the next one in its last LATE seconds (sites accept the code next
 *  to the current one, and this one would run out before it is sent). Null when the secret can't be read. */
export async function totpToType(secret: string, nowMs = Date.now()): Promise<string | null> {
  const p = parseTotp(secret);
  if (!p.ok) return null;
  const s = Math.floor(nowMs / 1000);
  const counter = Math.floor(s / p.spec.period);
  return totpAt(p.spec, p.spec.period - (s % p.spec.period) <= LATE ? counter + 1 : counter);
}

/** "123 456" / "1234 5678": easier to read off and type by hand. */
export function groupCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
