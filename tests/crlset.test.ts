// electron/crlset.ts — Chrome's revocation list for profiles this app launches. The cache, the seeding and the
// first-tab hold are pinned here; tests/crlset.live.test.ts runs a real browser against revoked hosts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  COMPONENT_DIR,
  CRLSET_APP_ID,
  CRLSET_FILE,
  HOLD_URL,
  NEW_TAB_URL,
  PipeCdp,
  ReadinessState,
  STAMP_FILE,
  crlsetArgsWarning,
  crlsetEnabled,
  holdUntilLive,
  installCrlset,
  parseHeader,
  resolveCrlset,
  seedCrlset,
} from "../electron/crlset";
import { omahaRequestBody } from "../electron/widevine";

function crlset(sequence: number, body = "payload"): Buffer {
  const header = Buffer.from(JSON.stringify({ ContentType: "CRLSet", Sequence: sequence, NotAfter: 0 }));
  const len = Buffer.alloc(2);
  len.writeUInt16LE(header.length, 0);
  return Buffer.concat([len, header, Buffer.from(body)]);
}

let tmp: string;
const saved = { ...process.env };
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-crlset-"));
  process.env.CLEARCOTE_CRLSET_DIR = path.join(tmp, "cache");
  delete process.env.CLEARCOTE_CRLSET_FILE;
  delete process.env.CLEARCOTE_CRLSET_URL;
});
afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the setting", () => {
  it("is on unless turned off", () => {
    expect(crlsetEnabled({})).toBe(true);
    expect(crlsetEnabled({ crlset: true })).toBe(true);
    expect(crlsetEnabled({ crlset: false })).toBe(false);
  });

  it("warns when the profile's own switches stop the list from loading", () => {
    expect(crlsetArgsWarning(["--disable-component-update"])).toMatch(/never reads the revocation list/);
    expect(crlsetArgsWarning(["--foo"])).toBeNull();
    expect(crlsetArgsWarning(undefined)).toBeNull();
  });
});

describe("CRLSet files", () => {
  it("reads the sequence from the header", () => expect(parseHeader(crlset(10849)).Sequence).toBe(10849));

  it("refuses what is not a CRLSet", () => {
    expect(() => parseHeader(Buffer.from([1]))).toThrow(/too short/);
    const other = Buffer.from(JSON.stringify({ ContentType: "Other", Sequence: 1 }));
    const len = Buffer.alloc(2);
    len.writeUInt16LE(other.length, 0);
    expect(() => parseHeader(Buffer.concat([len, other]))).toThrow(/ContentType/);
  });

  it("caches as <sequence>/crl-set, the layout the SDKs share", () => {
    const dest = installCrlset(crlset(42));
    expect(dest).toBe(path.join(tmp, "cache", "42", CRLSET_FILE));
    expect(parseHeader(fs.readFileSync(dest)).Sequence).toBe(42);
  });
});

describe("resolveCrlset", () => {
  it("uses the newest cached copy without contacting Google while the cache is fresh", async () => {
    installCrlset(crlset(7));
    installCrlset(crlset(12));
    fs.mkdirSync(path.join(tmp, "cache", "99"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "cache", "99", CRLSET_FILE), "garbage"); // skipped, not fatal
    fs.writeFileSync(path.join(tmp, "cache", STAMP_FILE), "");
    const found = await resolveCrlset();
    expect(parseHeader(fs.readFileSync(found)).Sequence).toBe(12);
  });

  it("CLEARCOTE_CRLSET_FILE wins", async () => {
    const file = path.join(tmp, "mine");
    fs.writeFileSync(file, crlset(3));
    process.env.CLEARCOTE_CRLSET_FILE = file;
    installCrlset(crlset(50));
    expect(await resolveCrlset()).toBe(file);
  });

  it("fills an empty cache from CLEARCOTE_CRLSET_URL", async () => {
    const http = await import("node:http");
    const server = http.createServer((_q, r) => r.end(crlset(77)));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.CLEARCOTE_CRLSET_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/crl-set`;
    try {
      const found = await resolveCrlset();
      expect(found).toBe(path.join(tmp, "cache", "77", CRLSET_FILE));
      expect(fs.existsSync(path.join(tmp, "cache", STAMP_FILE))).toBe(true);
    } finally {
      server.close();
    }
  });

  it("gives up on a first download that takes too long", async () => {
    const http = await import("node:http");
    const server = http.createServer(() => {}); // never answers
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    process.env.CLEARCOTE_CRLSET_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      await expect(resolveCrlset(200)).rejects.toThrow(/first download took over/);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("seedCrlset", () => {
  it("puts the file and a manifest where the component installer looks", () => {
    const src = installCrlset(crlset(10849));
    const udd = path.join(tmp, "udd");
    expect(seedCrlset(udd, src)).toBe(10849);
    const dir = path.join(udd, COMPONENT_DIR, "10849");
    expect(fs.readFileSync(path.join(dir, CRLSET_FILE))).toEqual(crlset(10849));
    expect(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).version).toBe("10849");
  });

  it("keeps a newer list the profile already has", () => {
    const udd = path.join(tmp, "udd");
    seedCrlset(udd, installCrlset(crlset(20)));
    expect(seedCrlset(udd, installCrlset(crlset(10)))).toBe(20);
    expect(fs.existsSync(path.join(udd, COMPONENT_DIR, "10"))).toBe(false);
  });
});

it("asks Google's updater for the CRLSet component through the Widevine client", () => {
  const body = omahaRequestBody("win32", "x64", CRLSET_APP_ID) as any;
  expect(body.request.app[0].appid).toBe(CRLSET_APP_ID);
  expect((omahaRequestBody("win32", "x64") as any).request.app[0].appid).toBe("oimompecagnajdejgnnjijobebaeigek");
});

describe("ReadinessState", () => {
  const server = (opened: number[]) => ({
    count: () => opened.length,
    reopenedAfter: (m: number) => opened.slice(1).some((t) => t > m),
  });

  it("ignores a drop before startup completed (a network change at launch)", () => {
    const s = new ReadinessState(server([0, 100]));
    expect(s.ready(150)).toBe(false);
    s.noteStartup(true, false, 200);
    expect(s.ready(250)).toBe(false);
  });

  it("counts a drop after startup completed", () => {
    const s = new ReadinessState(server([0, 300]));
    s.noteStartup(true, false, 200);
    expect(s.ready(310)).toBe(true);
  });

  it("startup already complete at the first check: live after the grace", () => {
    const s = new ReadinessState(server([0]));
    s.noteStartup(true, true, 0);
    expect(s.ready(1000)).toBe(false);
    expect(s.ready(1600)).toBe(true);
  });

  it("without the histogram, the first drop counts", () => {
    const s = new ReadinessState(server([0, 5]));
    s.histogram = false;
    expect(s.ready(10)).toBe(true);
  });
});

/** A browser that is up, completes startup on the `startupAt`-th histogram call and drops the probe at `dropAt`. */
function fakeBrowser(opts: { targets?: { targetId: string; type: string; url: string }[]; startupAt?: number; dropAt?: number }) {
  const calls: { method: string; params: any; sessionId?: string }[] = [];
  const opened = [0];
  let clock = 0;
  let histograms = 0;
  let probes = 0;
  const targets = opts.targets ?? [{ targetId: "T1", type: "page", url: HOLD_URL }];
  const cdp = {
    async send(method: string, params: any = {}, sessionId?: string): Promise<any> {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: "S1" };
      if (method === "Browser.getHistogram") {
        histograms++;
        if (opts.startupAt !== undefined && histograms >= opts.startupAt) return { histogram: {} };
        throw new Error("Cannot find histogram: Startup.AfterStartupTaskCount");
      }
      if (method === "Runtime.evaluate") {
        probes++;
        if (opts.dropAt !== undefined && probes === opts.dropAt) opened.push(clock);
        return { result: { value: 204 } };
      }
      return {};
    },
  };
  const probe = {
    url: "http://127.0.0.1:1/",
    count: () => opened.length,
    reopenedAfter: (m: number) => opened.slice(1).some((t) => t > m),
  };
  const timing = {
    now: () => clock,
    pause: async (ms: number) => {
      clock += ms;
    },
    timeoutMs: 2000,
  };
  return { cdp, probe, timing, calls };
}

describe("holdUntilLive", () => {
  it("waits for the drop after startup, then opens the start page in the held tab and detaches", async () => {
    const b = fakeBrowser({ startupAt: 3, dropAt: 6 });
    expect(await holdUntilLive(b.cdp, b.probe, { url: "https://example.com/" }, b.timing)).toBe(true);
    const nav = b.calls.filter((c) => c.method === "Page.navigate");
    expect(nav).toEqual([{ method: "Page.navigate", params: { url: "https://example.com/" }, sessionId: "S1" }]);
    expect(b.calls.at(-1)).toMatchObject({ method: "Target.detachFromTarget", params: { sessionId: "S1" } });
    // The probe ran only in the held tab, and nothing enabled a domain a page could notice.
    expect(b.calls.filter((c) => c.method === "Runtime.evaluate").every((c) => c.sessionId === "S1")).toBe(true);
    expect(b.calls.some((c) => c.method.endsWith(".enable"))).toBe(false);
  });

  it("still opens the start page when the list is not confirmed in time", async () => {
    const b = fakeBrowser({});
    expect(await holdUntilLive(b.cdp, b.probe, { url: "https://example.com/" }, b.timing)).toBe(false);
    expect(b.calls.some((c) => c.method === "Page.navigate" && c.params.url === "https://example.com/")).toBe(true);
  });

  it("no start page: the held tab becomes the new-tab page", async () => {
    const b = fakeBrowser({ startupAt: 1, dropAt: 2 });
    await holdUntilLive(b.cdp, b.probe, { newTab: true }, b.timing);
    expect(b.calls.find((c) => c.method === "Page.navigate")?.params.url).toBe(NEW_TAB_URL);
  });

  it("no start page and a restored session: the held tab closes", async () => {
    const b = fakeBrowser({
      startupAt: 1,
      dropAt: 2,
      targets: [
        { targetId: "T1", type: "page", url: HOLD_URL },
        { targetId: "T2", type: "page", url: "https://mail.example/" },
      ],
    });
    await holdUntilLive(b.cdp, b.probe, { newTab: true }, b.timing);
    expect(b.calls.some((c) => c.method === "Page.navigate")).toBe(false);
    expect(b.calls.find((c) => c.method === "Target.closeTarget")?.params).toEqual({ targetId: "T1" });
  });

  it("throws when there is no about:blank tab to hold", async () => {
    const b = fakeBrowser({ targets: [] });
    await expect(holdUntilLive(b.cdp, b.probe, { url: "https://example.com/" }, b.timing)).rejects.toThrow(/no about:blank tab/);
  });
});

describe("PipeCdp", () => {
  it("frames commands with NUL and matches replies by id, skipping events", async () => {
    const toBrowser = new PassThrough();
    const fromBrowser = new PassThrough();
    const written: string[] = [];
    toBrowser.on("data", (d) => written.push(d.toString()));
    const cdp = new PipeCdp(toBrowser, fromBrowser);
    const reply = cdp.send("Browser.getVersion");
    const failing = cdp.send("Browser.getHistogram", { name: "x" });
    await new Promise((r) => setImmediate(r));
    expect(written.join("")).toBe(
      JSON.stringify({ id: 1, method: "Browser.getVersion", params: {} }) + "\0" +
        JSON.stringify({ id: 2, method: "Browser.getHistogram", params: { name: "x" } }) + "\0",
    );
    // An event, then both replies split across chunks.
    fromBrowser.write(JSON.stringify({ method: "Target.targetCreated", params: {} }) + "\0" + '{"id":2,"error":{"message":"Cannot find');
    fromBrowser.write(' histogram: x"}}\0{"id":1,"result":{"product":"Chrome/155"}}\0');
    await expect(reply).resolves.toEqual({ product: "Chrome/155" });
    await expect(failing).rejects.toThrow(/Cannot find histogram/);
  });

  it("rejects what is pending, and later sends, once the browser closes the pipe", async () => {
    const fromBrowser = new PassThrough();
    const cdp = new PipeCdp(new PassThrough(), fromBrowser);
    const pending = cdp.send("Target.getTargets");
    fromBrowser.destroy();
    await expect(pending).rejects.toThrow(/closed the DevTools pipe/);
    await expect(cdp.send("Target.getTargets")).rejects.toThrow(/closed the DevTools pipe/);
  });
});
