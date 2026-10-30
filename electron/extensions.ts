// Browser extensions: added once (from a Chrome Web Store link, a .crx file or an unpacked folder), kept in
// <ROOT>/extensions/<id>/<version>/, and loaded into the profiles they are assigned to with --load-extension.
//
// An extension loaded this way never updates itself: the browser treats it as unpacked. So the version a
// profile runs is the one kept here, and "auto-update" is ours: when it is on, a launch first asks the Web
// Store for a newer version (at most every CHECK_EVERY_MS). When it is off, the version stays until someone
// presses Update. That is the point for wallets and ad tools: nobody's extension changes under them.
//
// The extension keeps its own ID across versions and folders. Chrome derives an unpacked extension's ID from
// the "key" in its manifest (else from its folder), and the ID is where its settings and storage live in
// each profile. So the key is written into every copy: the Web Store's key for store and .crx extensions
// (their ID stays the store ID, as sites that look for one expect), a key made here once for a folder.
//
// Store downloads are checked before use: the CRX3 signature must verify with the key whose ID is the one
// asked for. Nothing here touches Electron except the paths callers pass in.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { extractZip } from "./widevine";

export type ExtensionSource = "store" | "crx" | "folder";

export interface ExtensionEntry {
  /** Chrome's extension ID (32 letters a–p), the same in every profile. */
  id: string;
  name: string;
  version: string;
  description?: string;
  source: ExtensionSource;
  /** The store ID, the .crx file's name, or the folder it was copied from. */
  from: string;
  /** Store extensions only: check for a newer version before a launch. */
  autoUpdate: boolean;
  /** Base64 SubjectPublicKeyInfo written into the manifest as "key" (it fixes the ID). */
  key: string;
  /** A small PNG icon as a data: URL, for the list. */
  icon?: string;
  addedAt: number;
  updatedAt: number;
  /** Last time the store was asked for a newer version. */
  checkedAt?: number;
  /** A newer store version seen while auto-update is off. */
  available?: string;
}

/** What a launch loads, and what it could not. */
export interface ExtensionLoad {
  dirs: string[];
  warnings: string[];
}

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The Chrome version the store is told it serves (its minimum_chrome_version checks use it). */
export const PRODVERSION = "156.0.0.0";
const MAX_CRX_BYTES = 256 * 1024 * 1024;

export const extensionEvents = new EventEmitter();

// ── Paths and the index ─────────────────────────────────────────────────────

export function extensionsDir(root: string): string {
  return path.join(root, "extensions");
}
const indexPath = (root: string) => path.join(extensionsDir(root), "extensions.json");
export function versionDir(root: string, e: Pick<ExtensionEntry, "id" | "version">): string {
  return path.join(extensionsDir(root), e.id, safeVersion(e.version));
}
const safeVersion = (v: string) => (/^[\w.+-]{1,64}$/.test(v) ? v : "current");

export const isExtensionId = (s: unknown): s is string => typeof s === "string" && /^[a-p]{32}$/.test(s);

export function listExtensions(root: string): ExtensionEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath(root), "utf8"));
    return Array.isArray(data) ? data.filter((e) => e && isExtensionId(e.id)) : [];
  } catch {
    return [];
  }
}

function writeIndex(root: string, list: ExtensionEntry[]): void {
  const file = indexPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, file);
  extensionEvents.emit("changed");
}

function upsert(root: string, e: ExtensionEntry): ExtensionEntry {
  const list = listExtensions(root).filter((x) => x.id !== e.id);
  writeIndex(root, [...list, e].sort((a, b) => a.name.localeCompare(b.name)));
  return e;
}

export function getExtension(root: string, id: string): ExtensionEntry | undefined {
  return listExtensions(root).find((e) => e.id === id);
}

/** Change what may be changed by hand: auto-update. */
export function setExtension(root: string, id: string, patch: { autoUpdate?: boolean }): ExtensionEntry {
  const e = getExtension(root, id);
  if (!e) throw new Error("That extension is no longer here.");
  const next = { ...e };
  if (typeof patch.autoUpdate === "boolean") {
    next.autoUpdate = e.source === "store" && patch.autoUpdate;
    if (next.autoUpdate) delete next.checkedAt; // check at the next launch
  }
  return upsert(root, next);
}

/** Forget an extension and delete its files. Profiles that used it are the caller's to update. */
export function removeExtension(root: string, id: string): boolean {
  if (!isExtensionId(id)) return false;
  const list = listExtensions(root);
  if (!list.some((e) => e.id === id)) return false;
  writeIndex(root, list.filter((e) => e.id !== id));
  try {
    fs.rmSync(path.join(extensionsDir(root), id), { recursive: true, force: true });
  } catch {
    /* a running browser may still hold a file; the folder is no longer used either way */
  }
  return true;
}

// ── IDs and Web Store links ─────────────────────────────────────────────────

/** Chrome's ID for a public key: the first 16 bytes of its SHA-256, each hex digit as a letter a–p. */
export function idFromKey(spkiDer: Buffer): string {
  const hex = crypto.createHash("sha256").update(spkiDer).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/** The extension ID in a Web Store link (old or new store) or a bare ID; null when there is none. */
export function parseStoreRef(input: string): string | null {
  const s = String(input ?? "").trim();
  if (/^[a-p]{32}$/i.test(s)) return s.toLowerCase();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!/^(chromewebstore\.google\.com|chrome\.google\.com)$/i.test(u.hostname)) return null;
  const hit = u.pathname.split("/").find((part) => /^[a-p]{32}$/i.test(part));
  return hit ? hit.toLowerCase() : null;
}

export function storeDownloadUrl(id: string, prodversion = PRODVERSION): string {
  return (
    "https://clients2.google.com/service/update2/crx?response=redirect" +
    `&prodversion=${prodversion}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&installsource=ondemand&uc`)}`
  );
}

export function storeUpdateCheckUrl(id: string, prodversion = PRODVERSION): string {
  return (
    "https://clients2.google.com/service/update2/crx?response=updatecheck" +
    `&prodversion=${prodversion}&acceptformat=crx3&x=${encodeURIComponent(`id=${id}&uc`)}`
  );
}

/** The version in a Web Store update-check answer, or null (no such extension, or no update). */
export function parseUpdateCheck(xml: string): string | null {
  const tag = /<updatecheck\b[^>]*>/i.exec(xml)?.[0];
  if (!tag || /status="(?!ok")[^"]*"/i.test(tag)) return null;
  return /\bversion="([^"]+)"/i.exec(tag)?.[1] ?? null;
}

/** -1, 0 or 1, comparing Chrome's dotted version numbers. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ── CRX3 ────────────────────────────────────────────────────────────────────

export interface CrxInfo {
  /** The ID the file says it is (from its signed header). */
  id: string;
  /** The public key that ID comes from, base64 SPKI. */
  key: string;
  zip: Buffer;
}

/** Protobuf fields of one message: field number → its length-delimited values (the only kind CRX3 uses). */
function protoFields(buf: Buffer): Map<number, Buffer[]> {
  const out = new Map<number, Buffer[]>();
  let i = 0;
  const varint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error("malformed CRX3 header");
      const b = buf[i++];
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return v;
      shift += 7;
      if (shift > 49) throw new Error("malformed CRX3 header");
    }
  };
  while (i < buf.length) {
    const tag = varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 2) {
      const len = varint();
      if (i + len > buf.length) throw new Error("malformed CRX3 header");
      const list = out.get(field) ?? [];
      list.push(buf.subarray(i, i + len));
      out.set(field, list);
      i += len;
    } else if (wire === 0) varint();
    else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error("malformed CRX3 header");
  }
  return out;
}

/**
 * Read a CRX3 file and check its signature: the RSA or ECDSA proof made with the key whose ID the signed
 * header names must verify over the header and the zip. Throws when the file is not a CRX3 or the check fails.
 */
export function readCrx(buf: Buffer): CrxInfo {
  if (buf.subarray(0, 4).toString("latin1") !== "Cr24") throw new Error("This is not a .crx file.");
  if (buf.length < 12 || buf.readUInt32LE(4) !== 3) throw new Error("Only CRX3 files can be added (Chrome's format since 2019).");
  const headerLen = buf.readUInt32LE(8);
  if (12 + headerLen > buf.length) throw new Error("The .crx file is cut short.");
  const header = protoFields(buf.subarray(12, 12 + headerLen));
  const zip = buf.subarray(12 + headerLen);
  const signed = header.get(10000)?.[0];
  const crxId = signed ? protoFields(signed).get(1)?.[0] : undefined;
  if (!signed || !crxId || crxId.length !== 16) throw new Error("The .crx file has no signed ID.");
  const id = [...crxId.toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

  const lenLE = Buffer.alloc(4);
  lenLE.writeUInt32LE(signed.length);
  const message = Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), lenLE, signed, zip]);
  for (const proofs of [header.get(2) ?? [], header.get(3) ?? []]) {
    for (const proof of proofs) {
      const f = protoFields(proof);
      const pub = f.get(1)?.[0];
      const sig = f.get(2)?.[0];
      if (!pub || !sig || idFromKey(pub) !== id) continue;
      const key = crypto.createPublicKey({ key: pub, format: "der", type: "spki" });
      if (!crypto.verify("sha256", message, key, sig)) throw new Error("The .crx file's signature does not match its contents.");
      return { id, key: pub.toString("base64"), zip };
    }
  }
  throw new Error("The .crx file is not signed by the key its ID comes from.");
}

// ── Unpacking ───────────────────────────────────────────────────────────────

interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  description?: string;
  default_locale?: string;
  icons?: Record<string, string>;
  key?: string;
  [k: string]: unknown;
}

function readManifest(dir: string): Manifest {
  const file = path.join(dir, "manifest.json");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error("There is no manifest.json in it, so it is not an extension.");
  }
  try {
    return JSON.parse(text.replace(/^﻿/, "")) as Manifest;
  } catch {
    throw new Error("Its manifest.json could not be read.");
  }
}

/** "__MSG_appName__" → the default locale's text. */
function localized(dir: string, m: Manifest, s: string | undefined): string | undefined {
  const key = /^__MSG_(\w+)__$/.exec(s ?? "")?.[1];
  if (!key) return s;
  for (const loc of [m.default_locale, "en", "en_US"].filter(Boolean) as string[]) {
    try {
      const msgs = JSON.parse(fs.readFileSync(path.join(dir, "_locales", loc, "messages.json"), "utf8").replace(/^﻿/, ""));
      const hit = Object.entries(msgs).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1] as { message?: string } | undefined;
      if (hit?.message) return hit.message;
    } catch {
      /* next locale */
    }
  }
  return s;
}

function iconData(dir: string, m: Manifest): string | undefined {
  const sizes = Object.keys(m.icons ?? {}).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  const pick = sizes.find((n) => n >= 32) ?? sizes[sizes.length - 1];
  const rel = pick !== undefined ? m.icons?.[String(pick)] : undefined;
  if (!rel || !/\.png$/i.test(rel)) return undefined;
  const file = path.resolve(dir, rel.replace(/^\/+/, ""));
  if (!file.startsWith(path.resolve(dir) + path.sep)) return undefined;
  try {
    const png = fs.readFileSync(file);
    return png.length <= 64 * 1024 ? `data:image/png;base64,${png.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Make an unpacked copy loadable and pin its ID: drop the store's _metadata (Chrome refuses an unpacked
 * extension with a folder whose name starts with "_" it does not know), write the key, and read what the list shows.
 */
function finishCopy(dir: string, key: string): Pick<ExtensionEntry, "name" | "version" | "description" | "icon"> {
  fs.rmSync(path.join(dir, "_metadata"), { recursive: true, force: true });
  const m = readManifest(dir);
  if (m.manifest_version !== 3) {
    throw new Error(
      m.manifest_version === 2
        ? "This is a Manifest V2 extension. Chrome no longer runs those (since Chrome 139); look for its Manifest V3 version."
        : "Its manifest has no manifest_version 3, so Chrome would not load it.",
    );
  }
  if (!m.version) throw new Error("Its manifest has no version.");
  m.key = key;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
  return {
    name: (localized(dir, m, m.name) || "Extension").slice(0, 120),
    version: String(m.version),
    ...(m.description ? { description: (localized(dir, m, m.description) ?? "").slice(0, 300) } : {}),
    ...(iconData(dir, m) ? { icon: iconData(dir, m) } : {}),
  };
}

/** Unzip into a fresh folder next to the final one, finish it there, then move it into place. */
async function installZip(root: string, id: string, key: string, zip: Buffer): Promise<{ dir: string; meta: ReturnType<typeof finishCopy> }> {
  const base = path.join(extensionsDir(root), id);
  fs.mkdirSync(base, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ext-"));
  const staging = fs.mkdtempSync(path.join(base, ".new-"));
  try {
    const zipPath = path.join(tmp, "ext.zip");
    fs.writeFileSync(zipPath, zip);
    await extractZip(zipPath, staging, "the extension");
    const meta = finishCopy(staging, key);
    return { dir: moveIntoPlace(staging, versionDir(root, { id, version: meta.version })), meta };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function moveIntoPlace(staging: string, dir: string): string {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(staging, dir);
  return dir;
}

/** Keep the version in use and the one before it (a browser that is open may still read it). */
function pruneVersions(root: string, e: ExtensionEntry, previous?: string): void {
  const base = path.join(extensionsDir(root), e.id);
  const keep = new Set([safeVersion(e.version), previous ? safeVersion(previous) : ""]);
  for (const name of fs.readdirSync(base)) {
    if (keep.has(name)) continue;
    try {
      fs.rmSync(path.join(base, name), { recursive: true, force: true });
    } catch {
      /* in use: try again next time */
    }
  }
}

// ── Adding ──────────────────────────────────────────────────────────────────

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>;
const defaultFetch: Fetch = (url, init) => fetch(url, { redirect: "follow", ...init });

async function downloadFromStore(id: string, f: Fetch, prodversion?: string): Promise<CrxInfo> {
  const res = await f(storeDownloadUrl(id, prodversion), { signal: AbortSignal.timeout(120_000) });
  if (res.status === 204 || res.status === 404) throw new Error("The Chrome Web Store has no extension with that ID (or it is not public).");
  if (!res.ok) throw new Error(`The Chrome Web Store answered HTTP ${res.status}.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("The Chrome Web Store has no extension with that ID (or it is not public).");
  if (buf.length > MAX_CRX_BYTES) throw new Error("The extension is larger than 256 MB.");
  const crx = readCrx(buf);
  if (crx.id !== id) throw new Error("The Chrome Web Store sent a different extension than the one asked for.");
  return crx;
}

/** Add (or refresh) an extension from a Web Store link or ID. */
export async function addFromStore(root: string, ref: string, opts: { fetch?: Fetch; prodversion?: string } = {}): Promise<ExtensionEntry> {
  const id = parseStoreRef(ref);
  if (!id) throw new Error("Paste a Chrome Web Store link (chromewebstore.google.com/detail/…) or a 32-letter extension ID.");
  const crx = await downloadFromStore(id, opts.fetch ?? defaultFetch, opts.prodversion);
  const old = getExtension(root, id);
  const { meta } = await installZip(root, id, crx.key, crx.zip);
  const now = Date.now();
  const e = upsert(root, {
    ...meta,
    id,
    source: "store",
    from: id,
    autoUpdate: old?.autoUpdate ?? false,
    key: crx.key,
    addedAt: old?.addedAt ?? now,
    updatedAt: now,
    checkedAt: now,
  });
  pruneVersions(root, e, old?.version);
  return e;
}

/** Add an extension from the bytes of a .crx file. */
export async function addFromCrx(root: string, bytes: Buffer, fileName = "extension.crx"): Promise<ExtensionEntry> {
  if (bytes.length > MAX_CRX_BYTES) throw new Error("The extension is larger than 256 MB.");
  const crx = readCrx(bytes);
  const old = getExtension(root, crx.id);
  const { meta } = await installZip(root, crx.id, crx.key, crx.zip);
  const now = Date.now();
  const e = upsert(root, {
    ...meta,
    id: crx.id,
    source: "crx",
    from: path.basename(fileName).slice(0, 200),
    autoUpdate: false,
    key: crx.key,
    addedAt: old?.addedAt ?? now,
    updatedAt: now,
  });
  pruneVersions(root, e, old?.version);
  return e;
}

/** A key for a folder that has none, so its ID stays put across copies. */
function newKey(): string {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/**
 * Copy an unpacked extension folder in. Its manifest's key decides the ID when it has one; otherwise a key
 * is made here, and adding (or reloading) the same folder again keeps it.
 */
export function addFromFolder(root: string, folder: string): ExtensionEntry {
  const src = path.resolve(folder);
  const m = readManifest(src);
  const known = listExtensions(root).find((e) => e.source === "folder" && path.resolve(e.from) === src);
  let key = typeof m.key === "string" && m.key.trim() ? m.key.replace(/\s+/g, "") : known?.key ?? newKey();
  let id: string;
  try {
    id = idFromKey(Buffer.from(key, "base64"));
  } catch {
    key = newKey();
    id = idFromKey(Buffer.from(key, "base64"));
  }
  const base = path.join(extensionsDir(root), id);
  fs.mkdirSync(base, { recursive: true });
  const staging = fs.mkdtempSync(path.join(base, ".new-"));
  let meta: ReturnType<typeof finishCopy>;
  try {
    fs.cpSync(src, staging, {
      recursive: true,
      filter: (s) => !/(^|[\\/])(\.git|node_modules)([\\/]|$)/.test(path.relative(src, s)),
    });
    meta = finishCopy(staging, key);
    moveIntoPlace(staging, versionDir(root, { id, version: meta.version }));
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
  const old = getExtension(root, id);
  const now = Date.now();
  const e = upsert(root, {
    ...meta,
    id,
    source: "folder",
    from: src,
    autoUpdate: false,
    key,
    addedAt: old?.addedAt ?? now,
    updatedAt: now,
  });
  pruneVersions(root, e, old?.version);
  return e;
}

// ── Updating ────────────────────────────────────────────────────────────────

export interface UpdateResult {
  entry: ExtensionEntry;
  /** True when a new version was installed. */
  updated: boolean;
  previous?: string;
}

/**
 * Bring one extension up to date now: a store one from the store, a folder one copied again from its folder.
 * A .crx has nowhere to update from; add the new file instead.
 */
export async function updateExtension(root: string, id: string, opts: { fetch?: Fetch; prodversion?: string } = {}): Promise<UpdateResult> {
  const e = getExtension(root, id);
  if (!e) throw new Error("That extension is no longer here.");
  if (e.source === "crx") throw new Error("An extension added from a .crx file updates when you add the newer file.");
  if (e.source === "folder") {
    const entry = addFromFolder(root, e.from);
    return { entry, updated: entry.version !== e.version, previous: e.version };
  }
  const latest = await checkStore(e, opts);
  if (!latest || compareVersions(latest, e.version) <= 0) {
    const entry = upsert(root, { ...e, checkedAt: Date.now(), available: undefined });
    return { entry, updated: false };
  }
  const entry = await addFromStore(root, e.id, opts);
  return { entry: upsert(root, { ...entry, available: undefined }), updated: true, previous: e.version };
}

async function checkStore(e: ExtensionEntry, opts: { fetch?: Fetch; prodversion?: string }): Promise<string | null> {
  const f = opts.fetch ?? defaultFetch;
  const res = await f(storeUpdateCheckUrl(e.id, opts.prodversion), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The Chrome Web Store answered HTTP ${res.status}.`);
  return parseUpdateCheck(await res.text());
}

/** Ask the store about every store extension; auto-update ones are updated, the rest note what is available. */
export async function checkAll(root: string, opts: { fetch?: Fetch; prodversion?: string } = {}): Promise<{ updated: string[]; available: string[]; failed: string[] }> {
  const out = { updated: [] as string[], available: [] as string[], failed: [] as string[] };
  for (const e of listExtensions(root).filter((x) => x.source === "store")) {
    try {
      if (e.autoUpdate) {
        if ((await updateExtension(root, e.id, opts)).updated) out.updated.push(e.name);
        continue;
      }
      const latest = await checkStore(e, opts);
      const available = latest && compareVersions(latest, e.version) > 0 ? latest : undefined;
      upsert(root, { ...getExtension(root, e.id)!, checkedAt: Date.now(), available });
      if (available) out.available.push(e.name);
    } catch {
      out.failed.push(e.name);
    }
  }
  return out;
}

// ── Launch ──────────────────────────────────────────────────────────────────

/**
 * The folders a profile's extensions load from, updating the auto-update ones that are due first. Never
 * refuses a launch: an extension that is gone or cannot be updated is said in a warning.
 */
export async function extensionsForLaunch(
  root: string,
  ids: string[] | undefined,
  opts: { fetch?: Fetch; prodversion?: string; now?: number } = {},
): Promise<ExtensionLoad> {
  const out: ExtensionLoad = { dirs: [], warnings: [] };
  const now = opts.now ?? Date.now();
  for (const id of [...new Set(ids ?? [])]) {
    let e = getExtension(root, id);
    if (!e) {
      out.warnings.push(`An extension this profile uses (${id}) is not on this computer any more. Add it again under Extensions.`);
      continue;
    }
    if (e.source === "store" && e.autoUpdate && now - (e.checkedAt ?? 0) > CHECK_EVERY_MS) {
      try {
        const r = await updateExtension(root, id, opts);
        e = r.entry;
      } catch {
        // Offline or the store is slow: launch with the version that is here; the next launch tries again.
      }
    }
    const dir = versionDir(root, e);
    if (fs.existsSync(path.join(dir, "manifest.json"))) out.dirs.push(dir);
    else out.warnings.push(`The files of the extension “${e.name}” are missing. Update or add it again under Extensions.`);
  }
  return out;
}

/**
 * Put the extension folders into the arguments as ONE --load-extension (Chromium reads only the last one),
 * together with any the profile's own extra arguments already load.
 */
export function withExtensionArgs(args: string[], dirs: string[]): string[] {
  if (!dirs.length) return args;
  const own: string[] = [];
  const rest = args.filter((a) => {
    const m = /^--load-extension=(.*)$/i.exec(a);
    if (!m) return true;
    own.push(...m[1].split(",").filter(Boolean));
    return false;
  });
  const all = [...new Set([...own, ...dirs])];
  // Before the start page: Chromium opens every non-switch argument as a URL, so the switch goes in front of it.
  const urlAt = rest.findIndex((a) => !a.startsWith("--"));
  const sw = `--load-extension=${all.join(",")}`;
  if (urlAt < 0) return [...rest, sw];
  return [...rest.slice(0, urlAt), sw, ...rest.slice(urlAt)];
}
