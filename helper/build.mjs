// Builds the Clearcote Helper downloads, reproducibly.
//
//   npm run helper:build                 every platform, into helper-dist/
//   npm run helper:build -- win-x64      one platform
//   npm run helper:verify -- <download>  rebuild here and compare with a download, file by file
//
// What is in a download, and why you can check every byte of it:
//   lib/clearcote-helper.js  the helper's code: this repo's helper/ + electron/ sources, bundled by
//                            esbuild (pinned in package-lock.json), NOT minified, so you can read it.
//   runtime/node[.exe]       the official Node.js binary, byte for byte as nodejs.org ships it. The
//                            build checks its archive against the SHA-256 pinned in node-runtime.json,
//                            which you can compare with https://nodejs.org/dist/<version>/SHASUMS256.txt.
//   start script, README, LICENSEs, package.json, MANIFEST.sha256 (the hash of every file above).
//
// Same commit + same package-lock.json = the same bytes, on any OS: no timestamps (file times come
// from the commit, SOURCE_DATE_EPOCH), a fixed file order, no absolute paths. The archives
// themselves are deterministic too; MANIFEST.sha256 is what verify compares, so a re-zip by a mirror
// does not matter.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "helper-dist");
const CACHE = path.join(OUT, ".cache");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const runtime = JSON.parse(fs.readFileSync(path.join(ROOT, "helper", "node-runtime.json"), "utf8"));
const VERSION = pkg.version;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The commit, and its time as every file's time. A dirty tree is named as such in the bundle. */
function source() {
  const commit = process.env.HELPER_COMMIT || git("rev-parse", "HEAD") || "unknown";
  const epoch = Number(process.env.SOURCE_DATE_EPOCH || git("log", "-1", "--format=%ct") || 0);
  if (!epoch) throw new Error("No SOURCE_DATE_EPOCH and no git history to take it from.");
  const dirty = !process.env.HELPER_COMMIT && git("status", "--porcelain", "--", "helper", "electron", "build/icon.ico", "package.json", "package-lock.json") !== "";
  return { commit: dirty ? `${commit}+local-changes` : commit, epoch };
}

// ── The code ──────────────────────────────────────────────────────────────────

async function bundle(src) {
  const esbuild = await import("esbuild");
  const r = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ["helper/main.ts"],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    write: false,
    outfile: "lib/clearcote-helper.js",
    minify: false,
    keepNames: true,
    legalComments: "inline",
    charset: "utf8",
    sourcemap: false,
    // The shared code asks Electron for one thing, the data folder; the stub answers it.
    alias: { electron: "./helper/electron-stub.ts" },
    define: { __HELPER_VERSION__: JSON.stringify(VERSION) },
    banner: {
      js: [
        `// Clearcote Helper ${VERSION}`,
        `// Built from https://github.com/clearcotelabs/clearcote-profile-manager at commit ${src.commit}`,
        "// This file is the helper's whole program. It is not minified: read it, or rebuild it with",
        "// `npm ci && npm run helper:build` at that commit and compare (see helper/README.md).",
        "",
      ].join("\n"),
    },
    // A Windows checkout may have CRLF line ends (core.autocrlf); read every source with LF so the
    // bundle is the same bytes as on Linux or macOS.
    plugins: [
      {
        name: "lf-sources",
        setup(b) {
          b.onLoad({ filter: /\.(ts|js|json)$/ }, (args) => ({
            contents: fs.readFileSync(args.path, "utf8").replace(/\r/g, ""),
            loader: args.path.endsWith(".ts") ? "ts" : args.path.endsWith(".json") ? "json" : "js",
          }));
        },
      },
    ],
    logLevel: "warning",
  });
  return Buffer.from(r.outputFiles[0].contents);
}

// ── The Node.js runtime ───────────────────────────────────────────────────────

async function nodeArchive(target) {
  const t = runtime.targets[target];
  const name = `node-v${runtime.version}-${t.archive}`;
  const file = path.join(CACHE, name);
  let buf = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!buf || sha256(buf) !== t.sha256) {
    const url = `https://nodejs.org/dist/v${runtime.version}/${name}`;
    process.stdout.write(`  downloading ${url}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(file, buf);
  }
  const got = sha256(buf);
  if (got !== t.sha256) throw new Error(`${name}: SHA-256 ${got}, expected ${t.sha256} (node-runtime.json). Refusing to use it.`);
  return { buf, name, t };
}

/** The node binary and Node's LICENSE out of the official archive. */
async function nodeFiles(target) {
  const { buf, name, t } = await nodeArchive(target);
  const top = name.replace(/\.(zip|tar\.gz)$/, "");
  const entries = name.endsWith(".zip") ? readZip(buf) : readTarGz(buf);
  const bin = t.os === "win" ? `${top}/node.exe` : `${top}/bin/node`;
  const find = (p) => {
    const e = entries.get(p);
    if (!e) throw new Error(`${name} has no ${p}`);
    return e;
  };
  return { node: find(bin), license: find(`${top}/LICENSE`) };
}

// ── Assembling a download ─────────────────────────────────────────────────────

/** Windows wants CRLF in .cmd files. Made here from LF text, so every checkout gives the same bytes. */
export const crlf = (text) => text.replace(/\r/g, "").replace(/\n/g, "\r\n");

// The double-click entry on Windows: the helper moves to the tray and this window closes (tray.ts).
export const START_WIN = crlf(`@echo off
rem Starts the Clearcote Helper with the Node.js runtime next to this file. Nothing is installed.
rem It runs without a window, with an icon in the notification area (tray\\clearcote-tray.ps1).
rem To see its output in a window instead, start "Clearcote Helper (console).cmd".
title Clearcote Helper
"%~dp0runtime\\node.exe" "%~dp0lib\\clearcote-helper.js" --tray %*
if errorlevel 1 pause
`);
// The same helper in this console window, as before the tray icon: for troubleshooting.
export const START_WIN_CONSOLE = crlf(`@echo off
rem Starts the Clearcote Helper in this window, without the tray icon. Closing the window stops it.
title Clearcote Helper
"%~dp0runtime\\node.exe" "%~dp0lib\\clearcote-helper.js" %*
if errorlevel 1 pause
`);
const START_UNIX = `#!/bin/sh
# Starts the Clearcote Helper with the Node.js runtime next to this file. Nothing is installed.
here="$(cd "$(dirname "$0")" && pwd)"
exec "$here/runtime/node" "$here/lib/clearcote-helper.js" "$@"
`;

function readme(target, src) {
  return `Clearcote Helper ${VERSION} (${target})

Lets the Clearcote web profile manager start the Clearcote browser on this computer.
Start it and open the profile manager in your browser.

  Windows: double-click "Clearcote Helper.cmd". It moves to an icon in the notification area
           (next to the clock); right-click the icon to open its page or to quit.
           "Clearcote Helper (console).cmd" runs it in a console window instead.
  macOS:   double-click "Clearcote Helper.command" (first time: right-click, Open), keep its window open
  Linux:   ./clearcote-helper.sh, keep it running

Its own page, http://127.0.0.1:47821/, lists the sites you paired and everything they asked for.

What is in this folder
  lib/clearcote-helper.js   the whole program, readable (not minified)
  runtime/                  the official Node.js ${runtime.version} binary from nodejs.org, unchanged${target.startsWith("win-") ? "\n  tray/                     the tray icon: a PowerShell script (readable) and the Clearcote icon" : ""}
  MANIFEST.sha256           the SHA-256 of every file here

Built from https://github.com/clearcotelabs/clearcote-profile-manager
commit ${src.commit}

Check it yourself: clone that commit, run \`npm ci\` and
\`npm run helper:verify -- <this download>\`. It rebuilds the helper and compares every file.
`;
}

/** The Windows-only files: both start scripts and the tray icon (helper/tray.ps1 + build/icon.ico). */
export function windowsFiles() {
  return [
    { path: "Clearcote Helper.cmd", data: Buffer.from(START_WIN) },
    { path: "Clearcote Helper (console).cmd", data: Buffer.from(START_WIN_CONSOLE) },
    { path: "tray/clearcote-tray.ps1", data: Buffer.from(crlf(fs.readFileSync(path.join(ROOT, "helper", "tray.ps1"), "utf8"))) },
    { path: "tray/clearcote.ico", data: fs.readFileSync(path.join(ROOT, "build", "icon.ico")) },
  ];
}

/** Every file of one download, in a fixed order, with the modes they need. */
async function files(target, code, src) {
  const t = runtime.targets[target];
  const { node, license } = await nodeFiles(target);
  const isWin = t.os === "win";
  const list = [
    { path: "README.txt", data: Buffer.from(readme(target, src)) },
    { path: "LICENSE.txt", data: Buffer.from(fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8").replace(/\r/g, "")) },
    {
      path: "package.json",
      // The shared code names its version from ../package.json in its User-Agent.
      data: Buffer.from(JSON.stringify({ name: "clearcote-helper", version: VERSION, private: true, license: pkg.license }, null, 2) + "\n"),
    },
    { path: "lib/clearcote-helper.js", data: code },
    { path: isWin ? "runtime/node.exe" : "runtime/node", data: node, exec: true },
    { path: "runtime/NODE-LICENSE.txt", data: license },
    ...(isWin
      ? windowsFiles()
      : t.os === "mac"
        ? [{ path: "Clearcote Helper.command", data: Buffer.from(START_UNIX), exec: true }]
        : [{ path: "clearcote-helper.sh", data: Buffer.from(START_UNIX), exec: true }]),
  ];
  list.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = list.map((f) => `${sha256(f.data)}  ${f.path}`).join("\n") + "\n";
  list.push({ path: "MANIFEST.sha256", data: Buffer.from(manifest) });
  return list;
}

async function buildTarget(target, code, src) {
  const t = runtime.targets[target];
  if (!t) throw new Error(`Unknown target ${target}. Known: ${Object.keys(runtime.targets).join(", ")}`);
  const dir = `clearcote-helper-${VERSION}-${target}`;
  const list = await files(target, code, src);
  const archive = t.os === "win" ? writeZip(list, dir, src.epoch) : writeTarGz(list, dir, src.epoch);
  const out = `${dir}.${t.os === "win" ? "zip" : "tar.gz"}`;
  fs.writeFileSync(path.join(OUT, out), archive);
  return { out, sha: sha256(archive), manifest: list.at(-1).data.toString() };
}

// ── Deterministic archives (no library: every byte is decided here) ──────────

function dosTime(epoch) {
  const d = new Date(epoch * 1000);
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Compression is the one step whose bytes could differ between zlib builds, so it is pinned to one
// implementation: level 9, no SIMD-dependent strategy flags. The manifest, not the archive, is what
// verify compares, so even a different zlib cannot make a real download fail the check.
const deflate = (buf) => zlib.deflateRawSync(buf, { level: 9, memLevel: 9, windowBits: 15, strategy: zlib.constants.Z_DEFAULT_STRATEGY });

function writeZip(list, dir, epoch) {
  const { time, date } = dosTime(epoch);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of list) {
    const name = Buffer.from(`${dir}/${f.path}`, "utf8");
    const comp = deflate(f.data);
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 names
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is honoured
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((((f.exec ? 0o100755 : 0o100644) << 16) >>> 0), 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function tarHeader(name, size, mode, epoch, type = "0") {
  const h = Buffer.alloc(512);
  const put = (s, off, len) => h.write(s, off, len, "utf8");
  const oct = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 154);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  put(base, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(epoch, 12), 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

function writeTarGz(list, dir, epoch) {
  const parts = [];
  const dirs = new Set();
  for (const f of list) {
    const segs = f.path.split("/");
    for (let i = 0; i < segs.length; i++) {
      const d = [dir, ...segs.slice(0, i)].join("/") + "/";
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(tarHeader(d, 0, 0o755, epoch, "5"));
      }
    }
    parts.push(tarHeader(`${dir}/${f.path}`, f.data.length, f.exec ? 0o755 : 0o644, epoch));
    parts.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  gz[4] = gz[5] = gz[6] = gz[7] = 0; // no timestamp
  gz[9] = 255; // "unknown OS": zlib writes the build machine's OS here
  return gz;
}

// ── Reading the official Node.js archives (and our own, for verify) ──────────

function readZip(buf) {
  const out = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const raw = buf.subarray(start, start + csize);
    if (!name.endsWith("/")) out.set(name, method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function readTarGz(buf) {
  const tar = zlib.gunzipSync(buf);
  const out = new Map();
  let p = 0;
  let longName = null;
  while (p + 512 <= tar.length) {
    const h = tar.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    const str = (off, len) => h.subarray(off, off + len).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    const type = str(156, 1) || "0";
    const prefix = str(345, 155);
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const data = tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      const m = data.toString("utf8").match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
      continue;
    }
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type === "0" || type === "\0") out.set(name, Buffer.from(data));
  }
  return out;
}

// ── verify: rebuild here, compare with a download ────────────────────────────

async function verify(file) {
  const buf = fs.readFileSync(file);
  const entries = file.endsWith(".zip") ? readZip(buf) : readTarGz(buf);
  const top = [...entries.keys()][0].split("/")[0];
  const m = top.match(/^clearcote-helper-(.+)-((?:win|mac|linux)-(?:x64|arm64))$/);
  if (!m) throw new Error(`${file} does not look like a Clearcote Helper download.`);
  const [, ver, target] = m;
  if (ver !== VERSION) throw new Error(`The download is ${ver}; this checkout is ${VERSION}. Check out that release's tag first.`);
  const theirs = new Map([...entries].map(([k, v]) => [k.slice(top.length + 1), v]));
  // Rebuild for the commit the download names.
  const readmeText = theirs.get("README.txt")?.toString() || "";
  const commit = (readmeText.match(/^commit (\S+)/m) || [])[1];
  const src = source();
  if (commit && commit !== src.commit) {
    console.log(`Note: the download was built from ${commit}; this checkout is ${src.commit}.`);
  }
  const code = await bundle({ ...src, commit: commit || src.commit });
  const mine = await files(target, code, { ...src, commit: commit || src.commit });
  let bad = 0;
  for (const f of mine) {
    const t = theirs.get(f.path);
    const okay = t && sha256(t) === sha256(f.data);
    console.log(`${okay ? "same     " : "DIFFERENT"}  ${f.path}`);
    if (!okay) bad++;
    theirs.delete(f.path);
  }
  for (const extra of theirs.keys()) {
    console.log(`EXTRA      ${extra}  (not something the build makes)`);
    bad++;
  }
  console.log(bad ? `\n${bad} file(s) differ: this download is NOT what this source builds.` : "\nEvery file matches what this source builds.");
  process.exitCode = bad ? 1 : 0;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--verify") return verify(path.resolve(argv[1] || ""));
  const src = source();
  fs.mkdirSync(OUT, { recursive: true });
  const code = await bundle(src);
  fs.mkdirSync(path.join(OUT, "lib"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "lib", "clearcote-helper.js"), code);
  if (argv[0] === "--bundle-only") return console.log(`helper-dist/lib/clearcote-helper.js  ${sha256(code)}`);
  const targets = argv.length ? argv : Object.keys(runtime.targets);
  const sums = [];
  console.log(`Clearcote Helper ${VERSION}, commit ${src.commit}`);
  console.log(`lib/clearcote-helper.js  ${sha256(code)}`);
  for (const t of targets) {
    const r = await buildTarget(t, code, src);
    sums.push(`${r.sha}  ${r.out}`);
    console.log(`${r.sha}  ${r.out}`);
  }
  if (!argv.length) fs.writeFileSync(path.join(OUT, "SHA256SUMS"), sums.join("\n") + "\n");
}

// Run as a script (npm run helper:build); imported by the tests, it only exports.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
}
