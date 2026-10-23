// helper/tray.ts + the /tray/* routes in helper/server.ts + the Windows files build.mjs ships: the
// tray token check, the background/PowerShell arguments, that no web page (any Origin, a preflight,
// no token, a rebinding Host) reaches the tray's Quit, and that the scripts come out as Windows
// needs them (CRLF, the tray script ASCII-only) and agree with the helper on names.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createServer } from "../helper/server";
import { TokenStore } from "../helper/auth";
import {
  backgroundArgs,
  newTrayToken,
  TRAY_HEADER,
  TRAY_SCRIPT,
  TRAY_TOKEN_ENV,
  trayCommand,
  trayTokenOk,
  trayTooltip,
} from "../helper/tray";
// @ts-expect-error -- plain ESM build script, no types
import { crlf, START_WIN, START_WIN_CONSOLE, windowsFiles } from "../helper/build.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-helper-tray-"));
const TOKEN = newTrayToken();

describe("tray.ts", () => {
  it("checks the tray token in full, and never passes without one", () => {
    expect(trayTokenOk(TOKEN, TOKEN)).toBe(true);
    expect(trayTokenOk(TOKEN.slice(0, -1) + (TOKEN.endsWith("A") ? "B" : "A"), TOKEN)).toBe(false);
    expect(trayTokenOk(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(trayTokenOk(undefined, TOKEN)).toBe(false);
    expect(trayTokenOk("", "")).toBe(false);
    expect(trayTokenOk("x", undefined)).toBe(false);
    expect(trayTokenOk([TOKEN], TOKEN)).toBe(false);
  });

  it("makes a new token every time, 32 random bytes", () => {
    const a = newTrayToken();
    expect(a).not.toBe(newTrayToken());
    expect(Buffer.from(a, "base64url")).toHaveLength(32);
  });

  it("starts the background copy with the same options, --tray swapped for --background", () => {
    expect(backgroundArgs(["--tray", "--port", "47823", "--no-open"])).toEqual(["--port", "47823", "--no-open", "--background"]);
    expect(backgroundArgs(["--background", "--tray"])).toEqual(["--background"]);
  });

  it("runs Windows PowerShell by its full path, hidden, without profile, with the script by path", () => {
    const c = trayCommand({ script: "D:\\h\\tray\\clearcote-tray.ps1", port: 47823, helperPid: 4242, systemRoot: "C:\\WINDOWS" });
    expect(c.file).toBe("C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(c.args).toEqual([
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-File", "D:\\h\\tray\\clearcote-tray.ps1", "-Port", "47823", "-HelperPid", "4242",
    ]);
    // The token is not an argument (other programs can read command lines): it goes in the environment.
    expect(c.args.join(" ")).not.toMatch(/token/i);
    expect(trayCommand({ script: "s", port: 1, helperPid: 2 }).file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("says how many browsers are open, within Windows' 63-character tooltip", () => {
    expect(trayTooltip(0)).toBe("Clearcote Helper — running");
    expect(trayTooltip(1)).toBe("Clearcote Helper — running · 1 browser open");
    expect(trayTooltip(250)).toBe("Clearcote Helper — running · 250 browsers open");
    expect(trayTooltip(99999).length).toBeLessThanOrEqual(63);
  });
});

// ── The routes ────────────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function req(port: number, method: string, p: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    r.on("error", reject);
    r.end();
  });
}

function start(port: number, tray?: Parameters<typeof createServer>[0]["tray"]) {
  const s = createServer({
    port,
    version: "9.9.9-test",
    tokens: new TokenStore(path.join(TMP, `sites-${port}.json`)),
    handlers: {},
    log: () => {},
    onPairRequest: () => {},
    tray,
  });
  return new Promise<typeof s>((resolve) => s.server.listen(port, "127.0.0.1", () => resolve(s)));
}

describe("/tray/* routes", () => {
  let port = 0;
  let plain = 0;
  let quits = 0;
  const servers: http.Server[] = [];
  const tok = { [TRAY_HEADER]: TOKEN };

  beforeAll(async () => {
    port = await freePort();
    plain = await freePort();
    servers.push(
      (await start(port, { token: TOKEN, status: () => ({ tooltip: trayTooltip(2), browsers: 2 }), quit: () => void quits++ })).server,
      (await start(plain)).server,
    );
  });
  afterAll(() => {
    for (const s of servers) s.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it("answers the tray script: status with the tooltip, and Quit (after the answer is sent)", async () => {
    const s = await req(port, "GET", "/tray/status", tok);
    expect(s.status).toBe(200);
    expect(JSON.parse(s.body)).toEqual({ tooltip: "Clearcote Helper — running · 2 browsers open", browsers: 2 });
    expect(s.headers["access-control-allow-origin"]).toBeUndefined();

    const q = await req(port, "POST", "/tray/quit", tok);
    expect(q.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(quits).toBe(1);
  });

  it("refuses without the token, with a wrong one, and on a quit by GET", async () => {
    expect((await req(port, "POST", "/tray/quit")).status).toBe(403);
    expect((await req(port, "POST", "/tray/quit", { [TRAY_HEADER]: newTrayToken() })).status).toBe(403);
    expect((await req(port, "GET", "/tray/status", { authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    expect((await req(port, "GET", "/tray/quit", tok)).status).toBe(404);
    expect(quits).toBe(1);
  });

  it("refuses anything with an Origin: every web page, even the allowed sites and the helper's own page", async () => {
    for (const origin of ["https://app.clearcotelabs.com", "https://evil.example", `http://127.0.0.1:${port}`, "null"]) {
      const r = await req(port, "POST", "/tray/quit", { ...tok, origin });
      expect(r.status, origin).toBe(403);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
      // A page's preflight for the custom header gets no CORS answer, so the browser never sends the POST.
      const pre = await req(port, "OPTIONS", "/tray/quit", { origin, "access-control-request-method": "POST", "access-control-request-headers": TRAY_HEADER });
      expect(pre.status).toBe(403);
      expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(quits).toBe(1);
  });

  it("refuses a rebinding Host, and has no tray routes at all when no tray runs", async () => {
    expect((await req(port, "POST", "/tray/quit", { ...tok, host: `evil.example:${port}` })).status).toBe(421);
    expect((await req(plain, "POST", "/tray/quit", tok)).status).toBe(403);
    expect((await req(plain, "GET", "/tray/status", tok)).status).toBe(403);
    expect(quits).toBe(1);
  });
});

// ── What the Windows download ships ──────────────────────────────────────────

describe("the Windows files (build.mjs)", () => {
  const files = windowsFiles() as { path: string; data: Buffer }[];
  const get = (p: string) => files.find((f) => f.path === p)!.data;
  const bareLf = (b: Buffer) => /(^|[^\r])\n/.test(b.toString("latin1"));

  it("converts to CRLF the same way from LF or CRLF text", () => {
    expect(crlf("a\nb\n")).toBe("a\r\nb\r\n");
    expect(crlf("a\r\nb\r\n")).toBe("a\r\nb\r\n");
  });

  it("ships both start scripts, the tray script and the icon", () => {
    expect(files.map((f) => f.path)).toEqual(["Clearcote Helper.cmd", "Clearcote Helper (console).cmd", "tray/clearcote-tray.ps1", "tray/clearcote.ico"]);
    expect(path.posix.normalize(path.posix.join("lib", TRAY_SCRIPT.replace(/\\/g, "/")))).toBe("tray/clearcote-tray.ps1");
    expect(get("tray/clearcote.ico").subarray(0, 4)).toEqual(Buffer.from([0, 0, 1, 0]));
  });

  it("double-click starts the tray; the console script runs it as before", () => {
    expect(START_WIN).toContain('"%~dp0runtime\\node.exe" "%~dp0lib\\clearcote-helper.js" --tray %*');
    expect(START_WIN_CONSOLE).toContain('"%~dp0runtime\\node.exe" "%~dp0lib\\clearcote-helper.js" %*');
    expect(START_WIN_CONSOLE).not.toContain("--tray");
  });

  it("has only CRLF line ends in the .cmd and .ps1 files", () => {
    for (const p of ["Clearcote Helper.cmd", "Clearcote Helper (console).cmd", "tray/clearcote-tray.ps1"]) {
      expect(bareLf(get(p)), p).toBe(false);
      expect(get(p).toString("latin1").endsWith("\r\n"), p).toBe(true);
    }
  });

  it("keeps the tray script ASCII (Windows PowerShell 5.1 reads it in the system code page) and in step with the helper", () => {
    const ps = get("tray/clearcote-tray.ps1");
    expect([...ps].every((b) => b < 0x80)).toBe(true);
    const text = ps.toString("utf8");
    expect(text).toContain(`$env:${TRAY_TOKEN_ENV}`);
    expect(text.toLowerCase()).toContain(`'${TRAY_HEADER}'`);
    expect(text).toContain("'/tray/status'");
    expect(text).toContain("'/tray/quit'");
    expect(text).toContain("'clearcote.ico'");
    expect(text).toContain("$helper.HasExited");
    // Only ever the helper, by address: no other host.
    expect(text.match(/https?:\/\/[^\s"']+/g)?.every((u) => u.startsWith("http://127.0.0.1"))).toBe(true);
  });
});
