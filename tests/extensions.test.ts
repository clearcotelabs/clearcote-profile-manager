// electron/extensions.ts — adding extensions from the store, a .crx or a folder, keeping their ID, checking
// the CRX3 signature, updating, and what a launch loads. The .crx files here are real CRX3 files signed in
// the test, so the signature check runs for real; the store is a fake fetch serving them.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import * as ext from "../electron/extensions";

// ── Test files: a stored (uncompressed) zip and a signed CRX3 ───────────────

function zip(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const fname = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fname.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(fname.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, fname, data);
    central.push(cd, fname);
    offset += 30 + fname.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}

const varint = (n: number) => {
  const out: number[] = [];
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
};
const field = (no: number, body: Buffer) => Buffer.concat([varint(no * 8 + 2), varint(body.length), body]);

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { pub: publicKey.export({ type: "spki", format: "der" }) as Buffer, privateKey };
}

/** A CRX3 of `files`, signed with `kp`. `tamper` changes the zip after signing. */
function crx(files: Record<string, string | Buffer>, kp = keyPair(), opts: { tamper?: boolean } = {}): { buf: Buffer; id: string } {
  const z = zip(files);
  const id = ext.idFromKey(kp.pub);
  const crxId = Buffer.from([...id].map((c) => (c.charCodeAt(0) - 97).toString(16)).join(""), "hex");
  const signed = field(1, crxId);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signed.length);
  const sig = crypto.sign("sha256", Buffer.concat([Buffer.from("CRX3 SignedData\x00", "latin1"), len, signed, z]), kp.privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, kp.pub), field(2, sig)])), field(10000, signed)]);
  const pre = Buffer.alloc(12);
  pre.write("Cr24", 0, "latin1");
  pre.writeUInt32LE(3, 4);
  pre.writeUInt32LE(header.length, 8);
  const body = opts.tamper ? Buffer.concat([z.subarray(0, -1), Buffer.from([z[z.length - 1] ^ 1])]) : z;
  return { buf: Buffer.concat([pre, header, body]), id };
}

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifest_version: 3, name: "Test Wallet", version: "1.0.0", description: "A test", ...over });

/** A fake Web Store: serves `crxFor(id)` and answers update checks with `latest`. */
function store(crxFor: (id: string) => Buffer | null, latest?: () => string | null) {
  const calls: string[] = [];
  const f: ext.Fetch = async (url) => {
    calls.push(url);
    const id = /id%3D([a-p]{32})/.exec(url)?.[1] ?? "";
    if (url.includes("response=updatecheck")) {
      const v = latest?.();
      const xml = v
        ? `<?xml version="1.0"?><gupdate><app appid="${id}" status="ok"><updatecheck codebase="https://x/y.crx" version="${v}" status="ok"/></app></gupdate>`
        : `<?xml version="1.0"?><gupdate><app appid="${id}" status="ok"><updatecheck status="noupdate"/></app></gupdate>`;
      return { ok: true, status: 200, text: async () => xml, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const b = crxFor(id);
    if (!b) return { ok: false, status: 204, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer };
  };
  return { f, calls };
}

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-ext-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const readMan = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));

// ── Pure parts ──────────────────────────────────────────────────────────────

describe("parseStoreRef", () => {
  const id = "nkbihfbeogaeaoehlefnkodbefgpgknn";
  it("reads the new store, the old store and a bare ID", () => {
    expect(ext.parseStoreRef(`https://chromewebstore.google.com/detail/metamask/${id}`)).toBe(id);
    expect(ext.parseStoreRef(`https://chromewebstore.google.com/detail/metamask/${id}?hl=en&pli=1`)).toBe(id);
    expect(ext.parseStoreRef(`https://chrome.google.com/webstore/detail/metamask/${id}`)).toBe(id);
    expect(ext.parseStoreRef(`  ${id.toUpperCase()} `)).toBe(id);
  });
  it("refuses other sites and non-IDs", () => {
    expect(ext.parseStoreRef(`https://evil.example/detail/x/${id}`)).toBeNull();
    expect(ext.parseStoreRef("https://chromewebstore.google.com/category/extensions")).toBeNull();
    expect(ext.parseStoreRef("metamask")).toBeNull();
    expect(ext.parseStoreRef("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
  });
});

describe("parseUpdateCheck / compareVersions", () => {
  it("reads the version, and nothing for noupdate or an error", () => {
    expect(ext.parseUpdateCheck('<app><updatecheck codebase="u" version="12.3.1" status="ok"/></app>')).toBe("12.3.1");
    expect(ext.parseUpdateCheck('<app><updatecheck status="noupdate"/></app>')).toBeNull();
    expect(ext.parseUpdateCheck('<app status="error-unknownApplication"><updatecheck status="error-unknownApplication"/></app>')).toBeNull();
    expect(ext.parseUpdateCheck("")).toBeNull();
  });
  it("compares dotted versions numerically", () => {
    expect(ext.compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(ext.compareVersions("2.0", "2.0.0")).toBe(0);
    expect(ext.compareVersions("2.0.0.1", "2.0.1")).toBe(-1);
  });
});

describe("withExtensionArgs", () => {
  it("adds one --load-extension, merged with the profile's own, before the start page", () => {
    const out = ext.withExtensionArgs(["--a", "--load-extension=C:\\own", "--b", "https://example.com"], ["C:\\x", "C:\\y"]);
    expect(out).toEqual(["--a", "--b", "--load-extension=C:\\own,C:\\x,C:\\y", "https://example.com"]);
    expect(out.filter((a) => a.startsWith("--load-extension"))).toHaveLength(1);
  });
  it("leaves the arguments alone with nothing to load", () => {
    expect(ext.withExtensionArgs(["--a", "--load-extension=C:\\own"], [])).toEqual(["--a", "--load-extension=C:\\own"]);
  });
});

describe("readCrx", () => {
  it("returns the ID, key and zip of a correctly signed file", () => {
    const kp = keyPair();
    const { buf, id } = crx({ "manifest.json": manifest() }, kp);
    const r = ext.readCrx(buf);
    expect(r.id).toBe(id);
    expect(r.key).toBe(kp.pub.toString("base64"));
    expect(r.zip.subarray(0, 2).toString("latin1")).toBe("PK");
  });
  it("refuses a file changed after signing, a plain zip and CRX2", () => {
    expect(() => ext.readCrx(crx({ "manifest.json": manifest() }, keyPair(), { tamper: true }).buf)).toThrow(/signature/);
    expect(() => ext.readCrx(zip({ "manifest.json": manifest() }))).toThrow(/not a \.crx/);
    const v2 = crx({ "manifest.json": manifest() }).buf;
    v2.writeUInt32LE(2, 4);
    expect(() => ext.readCrx(v2)).toThrow(/CRX3/);
  });
  it("refuses a proof whose key is not the one its ID names", () => {
    const signer = keyPair();
    const { buf } = crx({ "manifest.json": manifest() }, signer);
    // Same header shape, but claim the ID of a different key: no proof matches it.
    const other = ext.idFromKey(keyPair().pub);
    const hex = Buffer.from([...other].map((c) => (c.charCodeAt(0) - 97).toString(16)).join(""), "hex");
    const at = buf.indexOf(Buffer.from([...ext.idFromKey(signer.pub)].map((c) => (c.charCodeAt(0) - 97).toString(16)).join(""), "hex"));
    hex.copy(buf, at);
    expect(() => ext.readCrx(buf)).toThrow(/not signed by the key/);
  });
});

// ── Adding ──────────────────────────────────────────────────────────────────

describe("addFromCrx", () => {
  it("unpacks into extensions/<id>/<version>, writes the key, drops _metadata, reads name and icon", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { buf, id } = crx({
      "manifest.json": manifest({ name: "__MSG_appName__", default_locale: "en", icons: { "48": "icon48.png" } }),
      "_locales/en/messages.json": JSON.stringify({ appName: { message: "Localized Wallet" } }),
      "_metadata/verified_contents.json": "[]",
      "icon48.png": png,
      "bg.js": "console.log(1)",
    });
    const e = await ext.addFromCrx(root, buf, "C:\\Downloads\\wallet.crx");
    expect(e).toMatchObject({ id, name: "Localized Wallet", version: "1.0.0", source: "crx", from: "wallet.crx", autoUpdate: false });
    expect(e.icon).toMatch(/^data:image\/png;base64,/);
    const dir = ext.versionDir(root, e);
    expect(readMan(dir).key).toBe(e.key);
    expect(ext.idFromKey(Buffer.from(readMan(dir).key, "base64"))).toBe(id);
    expect(fs.existsSync(path.join(dir, "_metadata"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "bg.js"), "utf8")).toBe("console.log(1)");
    expect(ext.listExtensions(root).map((x) => x.id)).toEqual([id]);
  });
  it("refuses Manifest V2 and leaves nothing behind", async () => {
    const { buf, id } = crx({ "manifest.json": manifest({ manifest_version: 2 }) });
    await expect(ext.addFromCrx(root, buf)).rejects.toThrow(/Manifest V2/);
    expect(ext.listExtensions(root)).toEqual([]);
    expect(fs.readdirSync(path.join(ext.extensionsDir(root), id))).toEqual([]);
  });
});

describe("addFromStore", () => {
  it("downloads, checks it is the extension asked for, and keeps the store ID", async () => {
    const kp = keyPair();
    const { buf, id } = crx({ "manifest.json": manifest() }, kp);
    const s = store((asked) => (asked === id ? buf : null));
    const e = await ext.addFromStore(root, `https://chromewebstore.google.com/detail/test/${id}`, { fetch: s.f });
    expect(e).toMatchObject({ id, source: "store", from: id, autoUpdate: false });
    expect(s.calls[0]).toContain("response=redirect");
    expect(s.calls[0]).toContain(`prodversion=${ext.PRODVERSION}`);
  });
  it("refuses a file for another ID, and an unknown ID", async () => {
    const { buf } = crx({ "manifest.json": manifest() });
    const asked = ext.idFromKey(keyPair().pub);
    await expect(ext.addFromStore(root, asked, { fetch: store(() => buf).f })).rejects.toThrow(/different extension/);
    await expect(ext.addFromStore(root, asked, { fetch: store(() => null).f })).rejects.toThrow(/no extension with that ID/);
    await expect(ext.addFromStore(root, "not a link")).rejects.toThrow(/Chrome Web Store link/);
  });
});

describe("addFromFolder", () => {
  it("makes a key once, so adding the folder again keeps the ID; Update copies the new version in", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-extsrc-"));
    try {
      fs.writeFileSync(path.join(src, "manifest.json"), manifest({ version: "0.1.0" }));
      fs.mkdirSync(path.join(src, "node_modules", "x"), { recursive: true });
      fs.writeFileSync(path.join(src, "node_modules", "x", "big.js"), "x");
      const a = ext.addFromFolder(root, src);
      expect(a.source).toBe("folder");
      expect(fs.existsSync(path.join(ext.versionDir(root, a), "node_modules"))).toBe(false);
      // The source folder itself is never written to.
      expect(JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8")).key).toBeUndefined();

      fs.writeFileSync(path.join(src, "manifest.json"), manifest({ version: "0.2.0" }));
      const b = ext.addFromFolder(root, src);
      expect(b.id).toBe(a.id);
      expect(b.version).toBe("0.2.0");
      expect(ext.listExtensions(root)).toHaveLength(1);
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
  it("uses the folder's own key when its manifest has one", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-extsrc-"));
    try {
      const kp = keyPair();
      fs.writeFileSync(path.join(src, "manifest.json"), manifest({ key: kp.pub.toString("base64") }));
      expect(ext.addFromFolder(root, src).id).toBe(ext.idFromKey(kp.pub));
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  });
  it("refuses a folder without manifest.json", () => {
    expect(() => ext.addFromFolder(root, root)).toThrow(/no manifest\.json/);
  });
});

// ── Updating and launching ──────────────────────────────────────────────────

describe("updates", () => {
  async function storeExt() {
    const kp = keyPair();
    let version = "1.0.0";
    const make = () => crx({ "manifest.json": manifest({ version }) }, kp);
    const id = make().id;
    let latest: string | null = null;
    const s = store(() => make().buf, () => latest);
    const e = await ext.addFromStore(root, id, { fetch: s.f });
    return {
      e,
      s,
      publish(v: string) {
        version = v;
        latest = v;
      },
    };
  }

  it("Update installs a newer store version, keeps the one before, and drops older ones", async () => {
    const { e, s, publish } = await storeExt();
    publish("1.1.0");
    const r1 = await ext.updateExtension(root, e.id, { fetch: s.f });
    expect(r1).toMatchObject({ updated: true, previous: "1.0.0" });
    publish("1.2.0");
    await ext.updateExtension(root, e.id, { fetch: s.f });
    expect(fs.readdirSync(path.join(ext.extensionsDir(root), e.id)).sort()).toEqual(["1.1.0", "1.2.0"]);
    expect(ext.getExtension(root, e.id)?.version).toBe("1.2.0");
  });

  it("checkAll notes what is available when auto-update is off, and installs it when on", async () => {
    const { e, s, publish } = await storeExt();
    publish("2.0.0");
    expect(await ext.checkAll(root, { fetch: s.f })).toMatchObject({ updated: [], available: ["Test Wallet"] });
    expect(ext.getExtension(root, e.id)).toMatchObject({ version: "1.0.0", available: "2.0.0" });
    ext.setExtension(root, e.id, { autoUpdate: true });
    expect(await ext.checkAll(root, { fetch: s.f })).toMatchObject({ updated: ["Test Wallet"] });
    expect(ext.getExtension(root, e.id)).toMatchObject({ version: "2.0.0" });
    expect(ext.getExtension(root, e.id)?.available).toBeUndefined();
  });

  it("a launch loads the kept version; auto-update off never asks the store", async () => {
    const { e, s, publish } = await storeExt();
    publish("3.0.0");
    const before = s.calls.length;
    const load = await ext.extensionsForLaunch(root, [e.id], { fetch: s.f, now: Date.now() + ext.CHECK_EVERY_MS * 2 });
    expect(load.dirs).toEqual([ext.versionDir(root, { id: e.id, version: "1.0.0" })]);
    expect(load.warnings).toEqual([]);
    expect(s.calls.length).toBe(before);
  });

  it("with auto-update on, a launch that is due updates first; offline it launches with what is there", async () => {
    const { e, s, publish } = await storeExt();
    ext.setExtension(root, e.id, { autoUpdate: true });
    publish("1.5.0");
    const load = await ext.extensionsForLaunch(root, [e.id], { fetch: s.f });
    expect(load.dirs).toEqual([ext.versionDir(root, { id: e.id, version: "1.5.0" })]);

    // Not due again for CHECK_EVERY_MS.
    const n = s.calls.length;
    await ext.extensionsForLaunch(root, [e.id], { fetch: s.f });
    expect(s.calls.length).toBe(n);

    const offline: ext.Fetch = async () => {
      throw new Error("ENOTFOUND");
    };
    const later = await ext.extensionsForLaunch(root, [e.id], { fetch: offline, now: Date.now() + ext.CHECK_EVERY_MS * 2 });
    expect(later).toEqual({ dirs: [ext.versionDir(root, { id: e.id, version: "1.5.0" })], warnings: [] });
  });

  it("auto-update is only for store extensions; a missing one is a warning, not a refusal", async () => {
    const { buf } = crx({ "manifest.json": manifest() });
    const c = await ext.addFromCrx(root, buf);
    expect(ext.setExtension(root, c.id, { autoUpdate: true }).autoUpdate).toBe(false);
    await expect(ext.updateExtension(root, c.id)).rejects.toThrow(/newer file/);
    const load = await ext.extensionsForLaunch(root, [c.id, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    expect(load.dirs).toHaveLength(1);
    expect(load.warnings[0]).toMatch(/aaaaaaaa.*not on this computer/);
  });

  it("removeExtension forgets it and deletes its files", async () => {
    const { buf } = crx({ "manifest.json": manifest() });
    const c = await ext.addFromCrx(root, buf);
    expect(ext.removeExtension(root, c.id)).toBe(true);
    expect(ext.listExtensions(root)).toEqual([]);
    expect(fs.existsSync(path.join(ext.extensionsDir(root), c.id))).toBe(false);
    expect(ext.removeExtension(root, c.id)).toBe(false);
  });
});
