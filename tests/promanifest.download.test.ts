// What the PRO download (electron/proBinary.ts) does with the signed release manifest, end to end through
// the real download, hash, extract and cache code. The network is a mocked fetch and the "build" is a small
// real archive with a launcher (and chrome.dll on Windows). Answers are signed with the test key
// (helpers/prosign.ts), pinned for this file only. What it pins:
//   - a signed build installs, and every later launch hashes its binaries again without downloading
//   - an answer without a manifest, signed by a key the app does not pin, for another revision or version
//     than the profile pins, or with an archive or binary hash that is not the signed one, is refused before
//     anything is downloaded
//   - an archive whose bytes or whose binaries are not the signed ones is discarded and never marked verified
//   - an installed build that was changed on disk is never returned: it is downloaded again, or the launch fails

import "./helpers/linux-on-mac"; // a Mac runner runs this as Linux (the macOS path has macos.download.test.ts)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { proEnsureBinary } from "../electron/proBinary";
import { ProManifestError } from "../electron/proManifest";
import { pinTestReleaseKey, restoreReleaseKeys, signedAnswer, unpinTestReleaseKey, type ProAnswer } from "./helpers/prosign";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-manifest-"));
const CACHE = path.join(ROOT, "cache");
const WIN = process.platform === "win32";
const PLAT = WIN ? "windows" : "linux";
const BIN = WIN ? "chrome.exe" : "chrome";
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The tar the app itself extracts with (System32 bsdtar on Windows; a PATH tar there can be an MSYS one). */
function tar(): string {
  if (!WIN) return "tar";
  const sys = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(sys) ? sys : "tar";
}

let seq = 0;
interface Build {
  tag: string;
  archive: Buffer;
  files: Record<string, string>;
  /** The route's answer for this build, signed for exactly these values. */
  answer: ProAnswer & { manifest: string };
}
/** A small real archive holding `files`, and the signed answer a release would serve for it. The archive is
 *  a plain tar: both tars read it whatever the asset is called. */
function build(files: Record<string, string> = {}, signedAs: Record<string, string> = {}): Build {
  const n = ++seq;
  const all: Record<string, string> = { [BIN]: `launcher ${n}`, ...(WIN ? { "chrome.dll": `engine ${n}` } : {}), "resources.pak": "pak", ...files };
  const src = path.join(ROOT, `src-${n}`);
  for (const [name, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    fs.writeFileSync(path.join(src, name), text);
  }
  const out = path.join(ROOT, `build-${n}.tar`);
  const r = spawnSync(tar(), ["-cf", out, "-C", src, "."], { windowsHide: true });
  if (r.status !== 0) throw new Error(`could not make the test archive: ${r.stderr}`);
  const archive = fs.readFileSync(out);
  const signed = { ...all, ...signedAs }; // what the manifest says is inside (the same, unless a test says otherwise)
  const tag = `pro-158.0.0.${n}-r${n}`;
  const answer = signedAnswer(
    {
      version: `158.0.0.${n}`,
      revision: `r${n}`,
      tag,
      asset: `clearcote-pro-158.0.0.${n}-${PLAT}-x64.${WIN ? "zip" : "tar.xz"}`,
      archive: WIN ? "zip" : "tar.xz",
      binary: BIN,
      url: `https://dl.example.test/${tag}`,
      sha256: sha(archive),
      exe_sha256: sha(signed[BIN]),
      ...(WIN ? { chrome_dll_sha256: sha(signed["chrome.dll"]) } : {}),
      size: archive.length,
    },
    PLAT,
  );
  return { tag, archive, files: all, answer };
}

const realFetch = globalThis.fetch;
let routeCalls: string[] = [];
let archiveFetches = 0;
/** Serve `answer` on the route and `body` (the build's archive unless given) as the archive. */
function serve(b: Build, opts: { answer?: Record<string, unknown>; body?: Buffer; archiveStatus?: number } = {}): void {
  globalThis.fetch = vi.fn(async (u: string | URL) => {
    const url = String(u);
    if (url.includes("/api/v1/download/pro")) {
      routeCalls.push(url);
      return new Response(JSON.stringify(opts.answer ?? b.answer), { status: 200 });
    }
    archiveFetches++;
    if (opts.archiveStatus) return new Response("no", { status: opts.archiveStatus });
    const body = opts.body ?? b.archive;
    return new Response(body, { headers: { "content-length": String(body.length) } });
  }) as unknown as typeof fetch;
}
const ensure = (version?: string) => proEnsureBinary("cc_lic_manifest_test", "https://example.test", version);
const installed = (b: Build, name = BIN) => path.join(CACHE, b.tag, "browser", name);
const verifiedMark = (b: Build) => path.join(CACHE, b.tag, ".verified");

/** The refusal's reason code, or a failure when the call resolved or threw something else. */
async function refusal(p: Promise<string>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProManifestError) return e.reason;
    throw e;
  }
  throw new Error("the build was accepted");
}

const OLD = { cache: process.env.CLEARCOTE_CACHE };
let warn: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  process.env.CLEARCOTE_CACHE = CACHE;
  pinTestReleaseKey();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  routeCalls = [];
  archiveFetches = 0;
  warn.mockClear();
  pinTestReleaseKey();
});
afterAll(() => {
  restoreReleaseKeys();
  warn.mockRestore();
  if (OLD.cache === undefined) delete process.env.CLEARCOTE_CACHE;
  else process.env.CLEARCOTE_CACHE = OLD.cache;
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 5 });
});

describe("a signed build", () => {
  it("is downloaded once, its binaries checked, and checked again on every later launch", async () => {
    const b = build();
    serve(b);
    const exe = await ensure();
    expect(exe).toBe(installed(b));
    expect(fs.readFileSync(exe, "utf8")).toBe(b.files[BIN]);
    expect(fs.existsSync(verifiedMark(b))).toBe(true);
    expect(archiveFetches).toBe(1);

    expect(await ensure()).toBe(exe);
    expect(await ensure(`158.0.0.${seq}-r${seq}`)).toBe(exe); // pinned to exactly this build
    expect(routeCalls).toHaveLength(3); // the route is asked every time: its answer carries the manifest
    expect(archiveFetches).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("hashes in upper case in the answer are the same hashes", async () => {
    const b = build();
    serve(b, { answer: { ...b.answer, sha256: String(b.answer.sha256).toUpperCase(), exe_sha256: String(b.answer.exe_sha256).toUpperCase() } });
    expect(await ensure()).toBe(installed(b));
  });
});

describe("refused before anything is downloaded", () => {
  const nothingFetched = (b: Build) => {
    expect(archiveFetches).toBe(0);
    expect(fs.existsSync(path.join(CACHE, b.tag))).toBe(false);
  };

  it("an unsigned answer (no manifest, or an empty one)", async () => {
    const b = build();
    const { manifest: _m, ...unsigned } = b.answer;
    serve(b, { answer: unsigned });
    expect(await refusal(ensure())).toBe("missing");
    serve(b, { answer: { ...b.answer, manifest: "" } });
    expect(await refusal(ensure())).toBe("missing");
    await expect(ensure()).rejects.toThrow(/release manifest check failed \(missing\): .*no signed release manifest.*Refusing to use this build\./);
    nothingFetched(b);
  });

  it("a manifest signed by a key the app does not pin", async () => {
    const b = build();
    serve(b);
    unpinTestReleaseKey(); // the app as shipped: only the production key
    expect(await refusal(ensure())).toBe("unknown-key");
    nothingFetched(b);
  });

  it("a manifest that was altered after signing", async () => {
    const b = build();
    const [text, sig] = b.answer.manifest.split(".");
    const payload = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
    const altered = Buffer.from(JSON.stringify({ ...payload, revision: "r999" })).toString("base64url");
    serve(b, { answer: { ...b.answer, revision: "r999", manifest: `${altered}.${sig}` } });
    expect(await refusal(ensure())).toBe("signature");
    nothingFetched(b);
  });

  it("the wrong revision: a correctly signed build that is not the one the profile pins", async () => {
    const b = build();
    serve(b);
    expect(await refusal(ensure(`${b.answer.version}-r999`))).toBe("revision");
    expect(await refusal(ensure("r999"))).toBe("revision");
    // and an answer that claims another revision than its manifest was signed for
    serve(b, { answer: { ...b.answer, revision: "r999", tag: `pro-${b.answer.version}-r999` } });
    expect(await refusal(ensure())).toBe("revision");
    nothingFetched(b);
    expect(fs.existsSync(path.join(CACHE, `pro-${b.answer.version}-r999`))).toBe(false);
  });

  it("the wrong version", async () => {
    const b = build();
    serve(b);
    expect(await refusal(ensure("157.0.0.1"))).toBe("version");
    serve(b, { answer: { ...b.answer, version: "157.0.0.1" } });
    expect(await refusal(ensure())).toBe("version");
    nothingFetched(b);
  });

  it("a build of another platform", async () => {
    const b = build();
    const other = WIN ? "linux" : "windows";
    serve(b, { answer: signedAnswer({ ...b.answer, chrome_dll_sha256: "c".repeat(64) }, other) });
    expect(await refusal(ensure())).toBe("platform");
    nothingFetched(b);
  });

  it("an altered archive hash or size in the answer", async () => {
    const b = build();
    const evil = build(); // another archive, which the altered answer points at
    serve(b, { answer: { ...b.answer, sha256: evil.answer.sha256, size: evil.answer.size }, body: evil.archive });
    expect(await refusal(ensure())).toBe("archive");
    serve(b, { answer: { ...b.answer, size: b.archive.length + 1 } });
    expect(await refusal(ensure())).toBe("archive");
    nothingFetched(b);
  });

  it("an altered binary hash in the answer", async () => {
    const b = build();
    serve(b, { answer: { ...b.answer, exe_sha256: "0".repeat(64) } });
    expect(await refusal(ensure())).toBe("binary");
    const { exe_sha256: _e, ...without } = b.answer;
    serve(b, { answer: without });
    expect(await refusal(ensure())).toBe("binary");
    nothingFetched(b);
  });

  it.runIf(WIN)("Windows: an altered or missing chrome.dll hash in the answer", async () => {
    const b = build();
    serve(b, { answer: { ...b.answer, chrome_dll_sha256: "0".repeat(64) } });
    expect(await refusal(ensure())).toBe("binary");
    const { chrome_dll_sha256: _d, ...without } = b.answer;
    serve(b, { answer: without });
    expect(await refusal(ensure())).toBe("binary");
    nothingFetched(b);
  });

  it("a build or archive name that is not a plain file name", async () => {
    const b = build();
    for (const over of [{ tag: "../../outside" }, { tag: "..\\outside" }, { tag: ".." }, { asset: "../x.zip" }, { asset: "a/b.zip" }]) {
      serve(b, { answer: { ...b.answer, ...over } }); // neither name is part of what the manifest binds
      await expect(ensure(), JSON.stringify(over)).rejects.toThrow(/unusable name/);
    }
    nothingFetched(b);
    expect(fs.existsSync(path.join(ROOT, "outside"))).toBe(false);
  });
});

describe("a download that is not what was signed", () => {
  it("other bytes than the signed archive are discarded", async () => {
    const b = build();
    const other = Buffer.from(b.archive);
    other[other.length - 600] ^= 0xff; // same size, another hash
    serve(b, { body: other });
    await expect(ensure()).rejects.toThrow(/PRO archive SHA-256 mismatch/);
    expect(fs.existsSync(verifiedMark(b))).toBe(false);
    expect(fs.existsSync(installed(b))).toBe(false);
  });

  it("an archive whose launcher is not the signed one is unpacked, refused and removed", async () => {
    // The archive's own hash is the signed one; the manifest names another launcher than the one inside.
    const b = build({}, { [BIN]: "the launcher the release key signed" });
    serve(b);
    expect(await refusal(ensure())).toBe("binary");
    await expect(ensure()).rejects.toThrow(new RegExp(`in the downloaded build ${b.tag.replace(/\./g, "\\.")}, ${BIN.replace(".", "\\.")} is not the file the release manifest names`));
    expect(fs.existsSync(verifiedMark(b))).toBe(false);
    expect(fs.existsSync(path.join(CACHE, b.tag, "browser"))).toBe(false);
  });

  it.runIf(WIN)("Windows: the same for chrome.dll", async () => {
    const b = build({}, { "chrome.dll": "the engine the release key signed" });
    serve(b);
    await expect(ensure()).rejects.toThrow(/chrome\.dll is not the file the release manifest names/);
    expect(fs.existsSync(verifiedMark(b))).toBe(false);
    expect(fs.existsSync(path.join(CACHE, b.tag, "browser"))).toBe(false);
  });
});

describe("an installed build that was changed on disk", () => {
  it("an edited launcher is never returned: the build is downloaded again", async () => {
    const b = build();
    serve(b);
    const exe = await ensure();
    fs.writeFileSync(exe, b.files[BIN].replace("launcher", "LAUNCHER")); // same size
    expect(await ensure()).toBe(exe);
    expect(fs.readFileSync(exe, "utf8")).toBe(b.files[BIN]);
    expect(archiveFetches).toBe(2);
    expect(fs.existsSync(verifiedMark(b))).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("does not match its signed release manifest");
  });

  it("when it cannot be downloaded again, the launch fails and the build stays unverified", async () => {
    const b = build();
    serve(b);
    const exe = await ensure();
    fs.writeFileSync(exe, "something else");
    serve(b, { archiveStatus: 503 });
    await expect(ensure()).rejects.toThrow(/download failed \(HTTP 503\)/);
    expect(fs.existsSync(verifiedMark(b))).toBe(false);
    await expect(ensure()).rejects.toThrow(/download failed \(HTTP 503\)/); // not trusted on the next try either
    serve(b);
    expect(await ensure()).toBe(exe);
    expect(fs.readFileSync(exe, "utf8")).toBe(b.files[BIN]);
  });

  it.runIf(WIN)("Windows: an edited chrome.dll beside the launcher is caught, even with the signed one elsewhere in the build", async () => {
    const b = build();
    serve(b);
    const exe = await ensure();
    const dll = installed(b, "chrome.dll");
    // The signed file moves into a folder that is listed first; an edited one takes its place beside the launcher.
    fs.mkdirSync(path.join(path.dirname(exe), "0"), { recursive: true });
    fs.copyFileSync(dll, path.join(path.dirname(exe), "0", "chrome.dll"));
    fs.writeFileSync(dll, b.files["chrome.dll"].replace("engine", "ENGINE"));
    expect(await ensure()).toBe(exe);
    expect(archiveFetches).toBe(2);
    expect(fs.readFileSync(dll, "utf8")).toBe(b.files["chrome.dll"]);
    expect(fs.existsSync(path.join(path.dirname(exe), "0"))).toBe(false); // a fresh copy, not a repaired one
  });

  it.runIf(WIN)("Windows: a missing chrome.dll is caught", async () => {
    const b = build();
    serve(b);
    const exe = await ensure();
    fs.rmSync(installed(b, "chrome.dll"));
    expect(await ensure()).toBe(exe);
    expect(archiveFetches).toBe(2);
    expect(String(warn.mock.calls[0][0])).toContain("chrome.dll is missing");
  });

  it("another build's signed answer does not vouch for it", async () => {
    // Two builds installed; the first one's files are swapped for the second one's (correctly signed) files.
    const a = build();
    const b = build();
    serve(a);
    const exeA = await ensure();
    serve(b);
    const exeB = await ensure();
    fs.copyFileSync(exeB, exeA);
    serve(a);
    expect(await ensure()).toBe(exeA);
    expect(archiveFetches).toBe(3); // a, b, and a again
    expect(fs.readFileSync(exeA, "utf8")).toBe(a.files[BIN]);
  });
});
