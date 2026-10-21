// Chrome's revocation list (CRLSet) for profiles this app launches. Port of the clearcote SDK's
// sdk/node/src/crlset.ts (SDK 0.57.0), with this app's own launch path in place of Playwright's.
//
// WHY THIS EXISTS. Real Chrome downloads a CRLSet through its component updater: Google's list of revoked and
// blocked certificate keys, which is how a CA distrust reaches the browser within hours (the eMudhra key
// compromise of 2026-10-17 shipped as CRLSet 10849). A Clearcote engine never gets one, because the updater
// URL is domain-substituted to a dead host. So every engine since 149 kept trusting those intermediates
// (tested on 12 builds, 149-155, free and PRO), and a profile here is where people sign in to real accounts.
//
// What a launch does, on unless Settings → Browser turns it off:
//
// 1. SEED: `<userDataDir>/CertificateRevocation/<sequence>/crl-set` plus a manifest. Chrome checks only that
//    the file exists, so a cached copy loads as is. An expired one still blocks everything it lists.
//    Nothing to un-suppress: --disable-component-update is a Playwright default, and this app spawns the
//    browser itself. A user extraArg that adds it back makes the seed useless, so the launch says so.
// 2. HOLD THE FIRST TAB on about:blank until the CRLSet is live, then open the start page. Chrome loads it
//    with BEST_EFFORT tasks that only run once startup completes, and startup completes when the first tab
//    has been idle for a moment. A start page that loads at once would be fetched unprotected.
//
// Readiness signal (as the SDK): applying a CRLSet changes the cert verifier, and the network service then
// closes its idle pooled connections. The held tab keeps one keep-alive HTTP connection to a local server on
// 127.0.0.1, and the CRLSet is live when that connection is dropped and re-opened AFTER startup completed
// (the `Startup.AfterStartupTaskCount` histogram): a network change at launch drops it too (seen on Linux).
//
// The probe and the histogram need DevTools, so a waiting launch adds --remote-debugging-pipe: the protocol
// runs over two inherited pipes that only this app holds, with no TCP port for anything else on the PC to
// reach. Only the held about:blank tab is attached, and it is detached before the start page opens, so no
// site ever has a DevTools session on it. The pipe stays open (Chrome closes itself when it closes, measured
// on 150), which ties the browser to the app: quitting already stops browsers, and a free-plan browser stops
// itself without the app anyway. A launch whose wait fails still opens the start page, with a warning.
//
// Where the CRLSet comes from: CLEARCOTE_CRLSET_FILE, else the newest copy in the cache CLEARCOTE_CRLSET_DIR or
// ~/.clearcote/crlset, the same `<sequence>/crl-set` layout the Python, Node and .NET SDKs share. An empty
// cache is filled at launch from Google's component updater (the Omaha client the Widevine fetch uses, sha256
// from the HTTPS update response); a cache older than 6 h is refreshed in the background while the launch
// uses it. CLEARCOTE_CRLSET_URL points the fetch at a mirror serving the raw crl-set file.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { OMAHA_URL, crx3ToZip, extractZip, omahaRequestBody, omahaUserAgent, parseUpdate, postJson } from "./widevine";

export const COMPONENT_DIR = "CertificateRevocation";
export const CRLSET_FILE = "crl-set";
export const CRLSET_APP_ID = "hfnkpimlhhgieaddgfemjhofmfblmnib"; // Chrome's CRLSet component
export const WAIT_TIMEOUT_MS = 15_000; // the readiness wait
export const FETCH_TIMEOUT_MS = 15_000; // how long a launch waits for a first download
export const REFRESH_MS = 6 * 3600_000; // a cache older than this is refreshed in the background
export const STAMP_FILE = ".last-check"; // in the cache root: mtime = the last fetch attempt
export const PIPE_SWITCH = "--remote-debugging-pipe";
export const HOLD_URL = "about:blank";
export const NEW_TAB_URL = "chrome://newtab/";
export const STARTUP_HISTOGRAM = "Startup.AfterStartupTaskCount"; // recorded once, when startup completes
export const ALREADY_STARTED_GRACE_MS = 1500; // startup was complete before the wait began: the drop may be past

let refreshJob: Promise<void> | undefined;

function errText(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

/** On unless Settings → Browser turned it off. */
export function crlsetEnabled(s: { crlset?: boolean }): boolean {
  return s.crlset !== false;
}

export function cacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLEARCOTE_CRLSET_DIR || path.join(homedir(), ".clearcote", "crlset");
}

/** The JSON header of a CRLSet file (little-endian uint16 length, then JSON). Throws on anything else. */
export function parseHeader(data: Buffer): { Sequence: number; [k: string]: unknown } {
  if (data.length < 2) throw new Error("not a CRLSet: too short");
  const length = data.readUInt16LE(0);
  let header: any;
  try {
    header = JSON.parse(data.subarray(2, 2 + length).toString("utf8"));
  } catch (e) {
    throw new Error(`not a CRLSet: bad header (${errText(e)})`);
  }
  if (!header || typeof header !== "object" || Array.isArray(header) || header.ContentType !== "CRLSet") {
    throw new Error("not a CRLSet: ContentType is not CRLSet");
  }
  if (!Number.isInteger(header.Sequence)) throw new Error("not a CRLSet: no Sequence");
  return header;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The highest-sequence `<dir>/<n>/crl-set` that parses, or undefined. */
function newestUnder(dir: string): string | undefined {
  let best: [number, string] | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const candidate = path.join(dir, name, CRLSET_FILE);
    if (!isFile(candidate)) continue;
    try {
      const seq = parseHeader(readFileSync(candidate)).Sequence;
      if (!best || seq > best[0]) best = [seq, candidate];
    } catch {
      continue;
    }
  }
  return best?.[1];
}

/** Store CRLSet bytes in the cache as `<cache>/<sequence>/crl-set` (atomically). Returns that path. */
export function installCrlset(data: Buffer, root: string = cacheRoot()): string {
  const sequence = parseHeader(data).Sequence;
  const destDir = path.join(root, String(sequence));
  mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, CRLSET_FILE);
  const tmp = `${dest}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, dest);
  return dest;
}

/** The current CRLSet from Google's component updater, verified against the sha256 of the HTTPS update
 *  response (the package itself may come over plain HTTP from edgedl). */
async function downloadFromGoogle(work: string, signal: AbortSignal): Promise<Buffer> {
  const [url, sha256] = parseUpdate(await postJson(OMAHA_URL, omahaRequestBody(undefined, undefined, CRLSET_APP_ID), "CRLSet", signal));
  const res = await fetch(url, { headers: { "User-Agent": omahaUserAgent() }, redirect: "follow", signal });
  if (!res.ok) throw new Error(`CRLSet download HTTP ${res.status}`);
  const blob = Buffer.from(await res.arrayBuffer());
  if (!sha256 || createHash("sha256").update(blob).digest("hex") !== sha256.toLowerCase()) {
    throw new Error("CRLSet sha256 mismatch - refusing to install");
  }
  const zipPath = path.join(work, "crlset.zip");
  writeFileSync(zipPath, crx3ToZip(blob));
  const unpacked = path.join(work, "unpacked");
  await extractZip(zipPath, unpacked, "the CRLSet");
  return readFileSync(path.join(unpacked, CRLSET_FILE));
}

function stampFresh(root: string): boolean {
  try {
    return Date.now() - statSync(path.join(root, STAMP_FILE)).mtimeMs < REFRESH_MS;
  } catch {
    return false;
  }
}

/** Download the current CRLSet into the cache and return its path (Google, or CLEARCOTE_CRLSET_URL). */
export async function fetchCrlset(signal?: AbortSignal): Promise<string> {
  const root = cacheRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, STAMP_FILE), ""); // a failed attempt counts too: no retry storm against Google
  const limit = signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
  const work = path.join(root, `.download-${process.pid}-${randomBytes(6).toString("hex")}`);
  mkdirSync(work, { recursive: true });
  try {
    const mirror = process.env.CLEARCOTE_CRLSET_URL;
    let data: Buffer;
    if (mirror) {
      const res = await fetch(mirror, { redirect: "follow", signal: limit });
      if (!res.ok) throw new Error(`CRLSet download HTTP ${res.status}`);
      data = Buffer.from(await res.arrayBuffer());
    } else {
      data = await downloadFromGoogle(work, limit);
    }
    return installCrlset(data, root);
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** At most one refresh at a time; the launch goes on with the cached copy. */
function refreshInBackground(): void {
  if (refreshJob) return;
  const job: Promise<void> = fetchCrlset()
    .then(() => undefined, () => undefined) // the cached copy still serves; the next stale launch retries
    .finally(() => {
      if (refreshJob === job) refreshJob = undefined;
    });
  refreshJob = job;
}

/**
 * The crl-set file to seed: CLEARCOTE_CRLSET_FILE, else the newest cached one, filling an empty cache from
 * Google first (at most FETCH_TIMEOUT_MS) and refreshing a stale one in the background. Throws when there is
 * none to be had; the caller turns that into a launch warning.
 */
export async function resolveCrlset(fetchTimeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const explicit = process.env.CLEARCOTE_CRLSET_FILE;
  if (explicit) {
    parseHeader(readFileSync(explicit));
    return explicit;
  }
  const root = cacheRoot();
  const found = newestUnder(root);
  if (found) {
    if (!stampFresh(root)) refreshInBackground();
    return found;
  }
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`the first download took over ${Math.round(fetchTimeoutMs / 1000)} s`));
    }, fetchTimeoutMs);
  });
  try {
    return await Promise.race([fetchCrlset(abort.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Place the CRLSet where the component installer finds it. Keeps a newer one already there (a reused
 *  profile). Returns the sequence now in the profile. */
export function seedCrlset(userDataDir: string, crlsetFile: string): number {
  const data = readFileSync(crlsetFile);
  const sequence = parseHeader(data).Sequence;
  const base = path.join(userDataDir, COMPONENT_DIR);
  const present = newestUnder(base);
  if (present) {
    const have = parseHeader(readFileSync(present)).Sequence;
    if (have >= sequence) return have;
  }
  const versionDir = path.join(base, String(sequence));
  mkdirSync(versionDir, { recursive: true });
  writeFileSync(path.join(versionDir, CRLSET_FILE), data);
  writeFileSync(
    path.join(versionDir, "manifest.json"),
    JSON.stringify({ manifest_version: 2, name: "crl-set-clearcote.data", version: String(sequence) }),
  );
  return sequence;
}

/** A warning when the profile's own switches stop the seeded CRLSet from loading, else null. */
export function crlsetArgsWarning(extraArgs: string[] = []): string | null {
  if (!extraArgs.some((a) => a === "--disable-component-update" || a.startsWith("--disable-component-update="))) return null;
  return "This profile's extra arguments include --disable-component-update, so the browser never reads the revocation list and still trusts certificates Chrome has revoked. Remove it, or turn off \"Block certificates Chrome has revoked\" in Settings → Browser.";
}

// ---------------------------------------------------------------------------------------------------------
// Readiness wait

/** HTTP/1.1 on 127.0.0.1 that records when the browser opens each TCP connection to it. */
export class ProbeServer {
  opened: number[] = []; // performance.now() of each connection
  url = "";
  private constructor(private readonly server: Server) {}

  static async start(): Promise<ProbeServer> {
    const server = createServer((_req, res) => {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Content-Length": "0" });
      res.end();
    });
    // keep-alive: the browser pools the connection. No idle timeout: a connection the server closed would be
    // re-opened and read as the CRLSet's drop.
    server.keepAliveTimeout = 0;
    const probe = new ProbeServer(server);
    server.on("connection", () => {
      probe.opened.push(performance.now());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.unref();
    probe.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    return probe;
  }

  count(): number {
    return this.opened.length;
  }

  /** A connection other than the first was opened after `moment`: the pooled one was dropped. */
  reopenedAfter(moment: number): boolean {
    return this.opened.slice(1).some((t) => t > moment);
  }

  close(): void {
    this.server.closeAllConnections();
    this.server.close();
  }
}

/**
 * When the CRLSet is live, from the probe's connections and the startup histogram. Only a drop seen after the
 * histogram appeared counts; if startup was already complete at the first check, the drop may have happened
 * before the probe connected, so it counts after a short grace. Without the histogram, the first drop counts.
 */
export class ReadinessState {
  startedAt: number | undefined;
  alreadyStarted = false;
  histogram = true; // false once the browser refused Browser.getHistogram

  constructor(readonly server: Pick<ProbeServer, "count" | "reopenedAfter">) {}

  noteStartup(present: boolean, firstCheck: boolean, now: number): void {
    if (this.startedAt === undefined && present) {
      this.startedAt = now;
      this.alreadyStarted = firstCheck;
    }
  }

  ready(now: number): boolean {
    if (!this.histogram) return this.server.count() >= 2;
    if (this.startedAt === undefined) return false;
    if (this.server.reopenedAfter(this.startedAt)) return true;
    return this.alreadyStarted && now - this.startedAt >= ALREADY_STARTED_GRACE_MS;
  }
}

/** DevTools over --remote-debugging-pipe: NUL-terminated JSON, the browser reads fd 3 and writes fd 4. */
export class PipeCdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private closed = false;

  constructor(private readonly toBrowser: Writable, fromBrowser: Readable) {
    // Errors on either end (the browser exited) must never reach the main process as an uncaught one.
    toBrowser.on("error", () => this.fail());
    fromBrowser.on("error", () => this.fail());
    fromBrowser.on("close", () => this.fail());
    // Read for as long as the pipe is open, so the browser never blocks on a full pipe.
    fromBrowser.on("data", (d: Buffer) => {
      this.buf += d.toString("utf8");
      let i: number;
      while ((i = this.buf.indexOf("\0")) >= 0) {
        const raw = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(raw);
        } catch {
          continue;
        }
        const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
        if (!p) continue; // an event
        this.pending.delete(m.id!);
        if (m.error) p.reject(new Error(m.error.message ?? "DevTools error"));
        else p.resolve(m.result);
      }
    });
  }

  private fail(): void {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("the browser closed the DevTools pipe"));
    this.pending.clear();
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the browser closed the DevTools pipe"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.toBrowser.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
    });
  }
}

/** What the browser's first tab was showing and what it should show once the wait ends. */
export type ReleaseTarget = { url: string } | { newTab: true };

interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// runs in the held about:blank tab
const PROBE_JS = (u: string) => `fetch(${JSON.stringify(u)}, { cache: "no-store" }).then((r) => r.status, () => 0)`;

/**
 * Hold the browser's about:blank tab until the CRLSet is live, then release it: navigate it to the start page,
 * or, with none, to the new-tab page (or close it when Chrome restored other tabs). Resolves to true when the
 * CRLSet was confirmed live, false when the wait gave up; the tab is released either way when it can be.
 */
export async function holdUntilLive(
  cdp: Pick<PipeCdp, "send">,
  probe: Pick<ProbeServer, "url" | "count" | "reopenedAfter">,
  release: ReleaseTarget,
  opts: { timeoutMs?: number; now?: () => number; pause?: (ms: number) => Promise<unknown> } = {},
): Promise<boolean> {
  const now = opts.now ?? (() => performance.now());
  const pause = opts.pause ?? sleep;
  const deadline = now() + (opts.timeoutMs ?? WAIT_TIMEOUT_MS);
  // The tab can take a moment to exist after spawn.
  let hold: TargetInfo | undefined;
  while (!hold && now() < deadline) {
    const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
    hold = targetInfos.find((t) => t.type === "page" && t.url === HOLD_URL);
    if (!hold) await pause(50);
  }
  if (!hold) throw new Error("the browser opened no about:blank tab to hold");
  const { sessionId } = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: hold.targetId, flatten: true });
  let live = false;
  try {
    const state = new ReadinessState(probe);
    let first = true;
    while (now() < deadline) {
      if (state.histogram && state.startedAt === undefined) {
        try {
          await cdp.send("Browser.getHistogram", { name: STARTUP_HISTOGRAM });
          state.noteStartup(true, first, now());
        } catch (e) {
          if (!/cannot find histogram/i.test(errText(e))) state.histogram = false;
        }
      }
      first = false;
      await cdp.send("Runtime.evaluate", { expression: PROBE_JS(probe.url), awaitPromise: true }, sessionId);
      if (state.ready(now())) {
        live = true;
        break;
      }
      await pause(50);
    }
  } finally {
    await releaseHold(cdp, hold.targetId, sessionId, release);
  }
  return live;
}

async function releaseHold(cdp: Pick<PipeCdp, "send">, holdId: string, sessionId: string, release: ReleaseTarget): Promise<void> {
  if ("url" in release) {
    await cdp.send("Page.navigate", { url: release.url }, sessionId);
    await cdp.send("Target.detachFromTarget", { sessionId });
    return;
  }
  // No start page: what Chrome would show at launch. A restored session already has its tabs, so the held
  // one goes; otherwise it becomes the new-tab page.
  const { targetInfos } = await cdp.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");
  const others = targetInfos.filter((t) => t.type === "page" && t.targetId !== holdId);
  if (others.length) {
    await cdp.send("Target.detachFromTarget", { sessionId });
    await cdp.send("Target.closeTarget", { targetId: holdId });
    return;
  }
  await cdp.send("Page.navigate", { url: NEW_TAB_URL }, sessionId);
  await cdp.send("Target.detachFromTarget", { sessionId });
}
