// Server-side personas (engine r51+): fetch the signed persona token for a launch and hand it to the engine.
//
// From r51 the engine derives no persona of its own. The launcher asks the persona service for one -- with the run
// token it just leased, the persona switches it is about to launch with (the *selector*) and the one fact of this
// machine the generator needs (the host GPU vendor) -- and passes the signed answer to the browser in
// CLEARCOTE_PERSONA_TOKEN, next to CLEARCOTE_RUN_TOKEN. Every launch gets one, persona or not: a selector without a
// seed yields the persona the engine computed for seed 0 up to r50. The engine checks the token's signature and
// that it was issued to this licence and lease for exactly these switches on this machine; it refuses to start
// without one. Engines before r51 ignore the variable, so this module does nothing for them.
//
// A captured profile (--fingerprint-profile) no longer rides on the command line: its exact JSON text goes to the
// service, which hashes it and names the hash in the token's selector; the launch carries
// --fingerprint-profile-sha256=<hash> so the engine can bind the two.
//
// Same contract as the SDKs (sdk/node/src/persona.ts, sdk/python/clearcote/_persona.py); the selector list mirrors
// the engine's and the service's: a switch added to one must be added to the others.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

export const TOKEN_ENV = "CLEARCOTE_PERSONA_TOKEN";
export const TOKEN_GZ_ENV = "CLEARCOTE_PERSONA_TOKEN_GZ";
export const API_ENV = "CLEARCOTE_PERSONA_API"; // comma-separated base URLs; tests and self-hosting
export const MARKER_SWITCH = "cc-persona-host-facts"; // only an r51+ engine implements it
export const DEFAULT_HOSTS = ["https://persona.clearcotelabs.com", "https://persona-us.clearcotelabs.com"];
// Over this many bytes the token goes gzip + base64 in TOKEN_GZ_ENV (a Windows environment variable holds at most
// 32,767 characters; a macOS persona lists 180 voices).
export const ENV_INLINE_LIMIT = 30000;
const REQUEST_TIMEOUT_MS = 8000;
const SKEW_SEC = 60;

export const SELECTOR_SWITCHES: ReadonlySet<string> = new Set([
  "fingerprint", "fingerprint-platform", "fingerprint-brand", "fingerprint-brand-version",
  "fingerprint-schema", "fingerprint-gpu-vendor", "fingerprint-gpu-renderer", "fingerprint-gpu-draw",
  "fingerprint-gpu-backend-real", "fingerprint-hardware-concurrency", "fingerprint-device-pixel-ratio",
  "fingerprint-color-scheme", "fingerprint-reduced-motion", "fingerprint-webauthn", "fingerprint-bluetooth",
  "fingerprint-webgpu-vendor", "fingerprint-webgpu-architecture", "disable-gpu-string-spoof",
  "disable-gpu-fingerprint", "disable-fingerprint-voices", "canvas-bridge-url", "fingerprint-profile-id",
  "fingerprint-profile-sha256",
]);
// The switches the engine's host-GPU-vendor detection reads; the host-facts run carries exactly these.
const HOST_FACT_SWITCHES: ReadonlySet<string> = new Set([
  "headless", "disable-gpu", "enable-gpu", "use-gl", "use-angle", "use-adapter-luid", "canvas-bridge-url",
  "fingerprint-gpu-host-vendor",
]);
const PROFILE_SWITCH = "fingerprint-profile";
const PROFILE_SHA_SWITCH = "fingerprint-profile-sha256";

export type Env = NodeJS.ProcessEnv;
export type Selector = Record<string, string>;
export type HostFacts = { gpu_vendor: string };
export type Probe = (bin: string, name: string) => boolean;
export type FactsRunner = (cmd: string[], env: Env) => string;
export type Fetcher = (runToken: string, sel: Selector, host: HostFacts, profileJson: string | null) => Promise<{ token: string; exp: number }>;
/** What a lease must offer here; the app's LeaseSession does. */
export interface LeaseLike { readonly token: string; readonly leaseId?: string | null }

export class PersonaServiceError extends Error {
  constructor(message: string) { super(message); this.name = "PersonaServiceError"; }
}

const tokens = new Map<string, { token: string; exp: number }>();
const facts = new Map<string, HostFacts>();
const probes = new Map<string, boolean>();

function parseSwitch(arg: string): [string, string] | null {
  if (!arg.startsWith("--") || arg.length === 2) return null;
  const eq = arg.indexOf("=");
  const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
  return name ? [name, eq < 0 ? "" : arg.slice(eq + 1)] : null;
}

/**
 * Whether the engine binary implements the command-line switch `name`. Chromium switch names are NUL-terminated
 * C-string literals in the binary, so a NUL-delimited search cannot collide with other text. On Windows the switches
 * live in chrome.dll next to the launcher; elsewhere in the executable. Cached per (path, size, mtime). Any failure
 * answers false, so an unreadable binary is treated as an engine before r51.
 */
export function engineSupportsSwitch(bin: string, name: string): boolean {
  try {
    let file = bin;
    if (process.platform === "win32") {
      const dll = path.join(path.dirname(bin), "chrome.dll");
      if (fs.existsSync(dll)) file = dll;
    }
    const st = fs.statSync(file);
    const key = `${file}|${name}|${st.size}|${Math.floor(st.mtimeMs)}`;
    const hit = probes.get(key);
    if (hit !== undefined) return hit;
    const needle = Buffer.from(`\0${name}\0`, "latin1");
    const fd = fs.openSync(file, "r");
    let found = false;
    try {
      const chunk = Buffer.alloc(8 * 1024 * 1024);
      let tail = Buffer.alloc(0);
      let pos = 0;
      while (!found) {
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (n <= 0) break;
        const window = Buffer.concat([tail, chunk.subarray(0, n)]);
        if (window.indexOf(needle) >= 0) found = true;
        tail = Buffer.from(window.subarray(Math.max(0, window.length - needle.length)));
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    probes.set(key, found);
    return found;
  } catch {
    return false;
  }
}

/** Whether `bin` is an r51+ engine, which starts only with a persona token. */
export function engineWantsPersonaToken(bin: string, supports: Probe = engineSupportsSwitch): boolean {
  return !!bin && supports(bin, MARKER_SWITCH);
}

/**
 * The selector the generator reads from `args` (last value wins, as Chromium keeps the last copy), the captured
 * profile's exact JSON text when --fingerprint-profile is present, and `args` with that switch removed and
 * --fingerprint-profile-sha256 added in its place.
 */
export function selectorFromArgs(args: readonly string[]): { sel: Selector; profileJson: string | null; args: string[] } {
  const sel: Selector = {};
  let profileJson: string | null = null;
  let out: string[] = [];
  for (const arg of args) {
    const s = parseSwitch(arg);
    if (s && s[0] === PROFILE_SWITCH) {
      let raw = Buffer.from(s[1], "base64");
      try { raw = gunzipSync(raw); } catch { /* an uncompressed profile */ }
      profileJson = raw.toString("utf8");
      continue;
    }
    if (s && SELECTOR_SWITCHES.has(s[0])) sel[s[0]] = s[0] === "canvas-bridge-url" ? "1" : s[1];
    out.push(arg);
  }
  if (profileJson !== null) {
    delete sel[PROFILE_SHA_SWITCH];
    out = out.filter((a) => parseSwitch(a)?.[0] !== PROFILE_SHA_SWITCH);
    const sha = createHash("sha256").update(profileJson, "utf8").digest("hex");
    sel[PROFILE_SHA_SWITCH] = sha;
    out.push(`--${PROFILE_SHA_SWITCH}=${sha}`);
  }
  return { sel, profileJson, args: out };
}

function factsCachePath(env: Env): string | null {
  const base = process.platform === "win32" ? env.LOCALAPPDATA : (env.HOME || os.homedir());
  return base ? path.join(base, ".clearcote", "persona-host-facts.json") : null;
}

function defaultRunner(cmd: string[], env: Env): string {
  const r = spawnSync(cmd[0], cmd.slice(1), { env, encoding: "utf8", timeout: 30000, windowsHide: true });
  return r.stdout ?? "";
}

/**
 * The facts of this machine the generator needs, as the engine itself reports them for a launch with these
 * switches: `chrome --cc-persona-host-facts` prints {"gpu_vendor": ...} and exits. Cached per (binary, the switches
 * that influence the answer) in memory and in ~/.clearcote.
 */
export function hostFacts(bin: string, args: readonly string[], runToken: string, runner: FactsRunner = defaultRunner, env: Env = process.env): HostFacts {
  const relevant = args.filter((a) => { const s = parseSwitch(a); return !!s && HOST_FACT_SWITCHES.has(s[0]); }).sort();
  let key: string;
  try {
    const st = fs.statSync(bin);
    key = JSON.stringify([path.resolve(bin), st.size, Math.floor(st.mtimeMs / 1000), relevant]);
  } catch {
    key = JSON.stringify([bin, 0, 0, relevant]);
  }
  const hit = facts.get(key);
  if (hit) return { ...hit };
  const disk = factsCachePath(env);
  if (disk && fs.existsSync(disk)) {
    try {
      const stored = (JSON.parse(fs.readFileSync(disk, "utf8")) as Record<string, HostFacts>)[key];
      if (stored && typeof stored.gpu_vendor === "string") { facts.set(key, stored); return { ...stored }; }
    } catch { /* unreadable cache: probe again */ }
  }
  const probeEnv: Env = { ...env, CLEARCOTE_RUN_TOKEN: runToken }; // the probe runs after the licence gate, like every launch
  delete probeEnv[TOKEN_ENV];
  delete probeEnv[TOKEN_GZ_ENV];
  let out: HostFacts;
  try {
    const text = runner([bin, `--${MARKER_SWITCH}`, ...relevant], probeEnv);
    const lines = text.trim().split(/\r?\n/);
    const parsed = JSON.parse(lines[lines.length - 1]) as { gpu_vendor?: unknown };
    if (typeof parsed.gpu_vendor !== "string") throw new Error("no gpu_vendor");
    out = { gpu_vendor: parsed.gpu_vendor };
  } catch (e) {
    throw new PersonaServiceError(`the engine did not report its host facts (${(e as Error).message})`);
  }
  facts.set(key, out);
  if (disk) {
    try {
      fs.mkdirSync(path.dirname(disk), { recursive: true });
      let all: Record<string, HostFacts> = {};
      try { all = JSON.parse(fs.readFileSync(disk, "utf8")); } catch { /* fresh cache */ }
      all[key] = out;
      fs.writeFileSync(disk, JSON.stringify(all));
    } catch { /* best effort */ }
  }
  return { ...out };
}

export function personaHosts(env: Env = process.env): string[] {
  const raw = (env[API_ENV] ?? "").trim();
  if (raw) return raw.split(",").map((h) => h.trim().replace(/\/+$/, "")).filter(Boolean);
  return DEFAULT_HOSTS;
}

/** POST the request to the first persona host that answers. */
export async function fetchPersonaToken(runToken: string, sel: Selector, host: HostFacts, profileJson: string | null = null, hosts: string[] = personaHosts(), timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ token: string; exp: number }> {
  const body = JSON.stringify(profileJson === null ? { token: runToken, sel, host } : { token: runToken, sel, host, profile_json: profileJson });
  const failures: string[] = [];
  for (const base of hosts) {
    let res: Response;
    let text = "";
    try {
      res = await fetch(`${base}/v1/persona`, {
        method: "POST", body, signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "user-agent": "clearcote-profile-manager" },
      });
      text = await res.text();
    } catch (e) {
      failures.push(`${base}: ${(e as Error).message}`);
      continue;
    }
    let answer: { persona_token?: unknown; exp?: unknown; error?: unknown } = {};
    try { answer = JSON.parse(text); } catch { /* not JSON */ }
    if (res.ok && typeof answer.persona_token === "string") return { token: answer.persona_token, exp: Number(answer.exp ?? 0) };
    const reason = typeof answer.error === "string" ? answer.error : `HTTP ${res.status}`;
    if (res.status >= 400 && res.status < 500) throw new PersonaServiceError(`the persona service refused this launch: ${reason}`);
    failures.push(`${base}: ${reason}`);
  }
  throw new PersonaServiceError(`no persona service answered (${failures.join("; ")}). The engine cannot start without a persona; check outbound HTTPS to persona.clearcotelabs.com.`);
}

/** A valid persona token for this lease + selector + host, from the cache or the service. */
export async function personaTokenFor(lease: LeaseLike, sel: Selector, host: HostFacts, profileJson: string | null, fetch: Fetcher = fetchPersonaToken): Promise<string> {
  const key = createHash("sha256").update(JSON.stringify([lease.leaseId ?? null, Object.fromEntries(Object.entries(sel).sort()), host])).digest("hex");
  const now = Date.now() / 1000;
  const hit = tokens.get(key);
  if (hit && hit.exp > now + SKEW_SEC) return hit.token;
  const got = await fetch(lease.token, sel, host, profileJson);
  tokens.set(key, got);
  return got.token;
}

/** `env` with the token the way the engine reads it (gzip + base64 when long). */
export function injectPersonaToken(env: Env, token: string): Env {
  const out: Env = { ...env };
  delete out[TOKEN_ENV];
  delete out[TOKEN_GZ_ENV];
  if (token.length > ENV_INLINE_LIMIT) out[TOKEN_GZ_ENV] = gzipSync(Buffer.from(token, "ascii"), { level: 9 }).toString("base64");
  else out[TOKEN_ENV] = token;
  return out;
}

export interface PersonaLaunch {
  /** The launch args, with a captured profile replaced by its hash. */
  args: string[];
  /** `base` with the persona token added (or `base` itself when this engine needs none). */
  env(base: Env | undefined): Env | undefined;
}

/**
 * Prepare a launch of `bin`: on an r51+ engine with a lease, fetch the persona token; `env()` then adds it to the
 * launch environment. Otherwise the args come back unchanged and `env()` is the identity.
 */
export async function preparePersonaLaunch(bin: string, args: readonly string[], lease: LeaseLike | null | undefined,
  deps: { supports?: Probe; runner?: FactsRunner; fetch?: Fetcher; env?: Env } = {}): Promise<PersonaLaunch> {
  if (!lease?.token || !engineWantsPersonaToken(bin, deps.supports)) return { args: [...args], env: (b) => b };
  const { sel, profileJson, args: out } = selectorFromArgs(args);
  const host = hostFacts(bin, out, lease.token, deps.runner, deps.env);
  const token = await personaTokenFor(lease, sel, host, profileJson, deps.fetch);
  return { args: out, env: (b) => injectPersonaToken(b ?? { ...process.env }, token) };
}

export function clearPersonaCaches(): void {
  tokens.clear();
  facts.clear();
  probes.clear();
}
