// electron/launcher.ts launch() — the bookkeeping around a launch, with the network, the download
// and the spawn stubbed. What it pins:
//   - a licence refusal carries its CODE to the UI (so the card can say what to do about it)
//   - a launch records lastLaunchedAt on the profile AS SAVED NOW, and leaves updatedAt alone —
//     the renderer used to save the copy it held at click time, clobbering edits made during a
//     long first download
//   - the plan a real lease reports is remembered for the header; an offline-grace lease is not

import "./helpers/linux-on-mac"; // pins the Windows/Linux behaviour; a Mac runner runs this suite as Linux
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-flow-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

// The download step is controllable, so a test can act while a "download" is in flight.
let downloadGate: Promise<void> = Promise.resolve();
vi.mock("../electron/catalog", async (orig) => {
  const real = await orig<typeof import("../electron/catalog")>();
  return {
    ...real,
    fetchCatalog: vi.fn(async () => ({
      schema: 1,
      builds: [
        {
          major: 153,
          version: "153.0.8010.36",
          tier: "pro",
          tag: "pro-153.0.8010.36",
          platforms: {
            windows: { archive: "zip", binary: "chrome.exe" },
            linux: { archive: "tar.xz", binary: "chrome" },
          },
        },
      ],
    })),
  };
});
vi.mock("../electron/proBinary", async (orig) => {
  const real = await orig<typeof import("../electron/proBinary")>();
  return {
    ...real,
    proEnsureBinary: vi.fn(async () => {
      await downloadGate;
      return path.join(ROOT, "fake-chrome.exe");
    }),
  };
});
const leaseMock = vi.fn();
vi.mock("../electron/license", async (orig) => {
  const real = await orig<typeof import("../electron/license")>();
  return { ...real, acquireLease: (...a: unknown[]) => leaseMock(...a) };
});
const spawnMock = vi.fn();
vi.mock("../electron/winlaunch", () => ({
  warmFiles: () => {},
  isWinLaunchRace: () => false,
  spawnBrowser: (...a: unknown[]) => spawnMock(...a),
}));
// Never a real taskkill against a fake pid: the polite close is played by the fake child.
const stopMock = vi.fn(async (child: EventEmitter & { exitCode: number | null }) => {
  child.exitCode = 0;
  child.emit("exit", 0, null);
  return "graceful" as const;
});
vi.mock("../electron/procstop", () => ({ stopGracefully: (c: never) => stopMock(c) }));
// The first-tab hold talks to a real browser over its pipe; tests/crlset.test.ts covers it.
const holdMock = vi.fn();
vi.mock("../electron/crlset", async (orig) => {
  const real = await orig<typeof import("../electron/crlset")>();
  return { ...real, holdUntilLive: (...a: unknown[]) => holdMock(...a) };
});

type L = typeof import("../electron/launcher");
type P = typeof import("../electron/profiles");
type S = typeof import("../electron/store");
let launcher: L;
let profiles: P;
let store: S;

const tokenFor = (plan: string) => `${Buffer.from(JSON.stringify({ plan, lic: "x" })).toString("base64url")}.sig`;
function lease(plan: string, leaseId = "L1") {
  return {
    token: tokenFor(plan),
    leaseId,
    bindLaunch: () => ({ path: path.join(ROOT, "run-token"), release: () => {} }),
    stop: async () => {},
  };
}
function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { pid: number; kill: () => void; stderr: EventEmitter; exitCode: number | null };
  c.pid = 4242;
  c.exitCode = null;
  c.stderr = new EventEmitter();
  c.kill = () => c.emit("exit", 0);
  // What a pipe launch is given: fds 3 and 4 for DevTools.
  (c as unknown as { stdio: unknown[] }).stdio = [null, null, c.stderr, new PassThrough(), new PassThrough()];
  return c;
}

beforeAll(async () => {
  launcher = await import("../electron/launcher");
  profiles = await import("../electron/profiles");
  store = await import("../electron/store");
});
afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(ROOT, "profiles"), { recursive: true, force: true });
  // The revocation-list hold has its own describe below; everything else pins the launch without it.
  store.writeSettings({ licenseKey: "cc_lic_test_key", crlset: false });
  downloadGate = Promise.resolve();
  leaseMock.mockReset();
  spawnMock.mockReset();
  spawnMock.mockImplementation(async () => fakeChild());
});
afterEach(() => {
  for (const id of launcher.listRunning()) launcher.stop(id);
});

const profile = (id: string, over: Record<string, unknown> = {}) =>
  profiles.saveProfile({ id, name: id, fingerprint: `seed-${id}`, createdAt: "", updatedAt: "", ...over } as never);

describe("launch() — licence refusals", () => {
  it("a concurrency refusal returns its code, spawns nothing, and records no launch", async () => {
    const { ConcurrencyLimitError } = await import("../electron/license");
    leaseMock.mockRejectedValue(new ConcurrencyLimitError("Concurrency limit reached (1/1 in use)."));
    const p = profile("busy");
    const r = await launcher.launch(p);
    expect(r).toMatchObject({ ok: false, code: "CONCURRENCY_LIMIT_EXCEEDED", error: "Concurrency limit reached (1/1 in use)." });
    expect(spawnMock).not.toHaveBeenCalled();
    expect(profiles.getProfile("busy")?.lastLaunchedAt).toBeUndefined();
  });

  it("an error with no code still reports the message (code undefined, not a crash)", async () => {
    leaseMock.mockRejectedValue(new Error("boom"));
    const r = await launcher.launch(profile("plain"));
    expect(r).toMatchObject({ ok: false, error: "boom" });
    expect(r.code).toBeUndefined();
  });
});

describe("launch() — a proxy that cannot be read", () => {
  it("refuses before the licence or the browser, instead of launching on this PC's own IP", async () => {
    const r = await launcher.launch(profile("badproxy", { proxy: "relay.example.com:port:user:pw" }));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/proxy address cannot be read/);
    expect(leaseMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(profiles.getProfile("badproxy")?.lastLaunchedAt).toBeUndefined();
  });

  it("a vendor colon form with a scheme launches through that proxy (the 10-23 report)", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    const r = await launcher.launch(profile("colon", { proxy: "socks5://relay-eu.example.com:1080:plan-a-country-dk:pw" }));
    expect(r.ok).toBe(true);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--proxy-server=socks5://relay-eu.example.com:1080");
    expect(args).toContain("--socks5-credentials=plan-a-country-dk:pw");
    expect(args).toContain("--disable-quic");
  });
});

describe("launch() — bookkeeping on success", () => {
  it("records lastLaunchedAt and leaves updatedAt alone", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    const saved = profile("ok");
    const before = Date.now();
    const r = await launcher.launch(saved);
    expect(r).toMatchObject({ ok: true, pid: 4242, pro: true });
    const disk = profiles.getProfile("ok")!;
    expect(Date.parse(disk.lastLaunchedAt!)).toBeGreaterThanOrEqual(before - 5);
    expect(disk.updatedAt).toBe(saved.updatedAt);
  });

  it("an edit saved DURING a long first download survives the launch", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    let finishDownload!: () => void;
    downloadGate = new Promise<void>((res) => (finishDownload = res));
    const clicked = profile("dl", { name: "as clicked" }); // the copy the UI held at click time
    const launching = launcher.launch(clicked);
    await new Promise((r) => setTimeout(r, 20)); // …the download is running…
    profiles.saveProfile({ ...profiles.getProfile("dl")!, name: "edited during download" });
    finishDownload();
    expect((await launching).ok).toBe(true);
    const disk = profiles.getProfile("dl")!;
    expect(disk.name).toBe("edited during download");
    expect(disk.lastLaunchedAt).toBeTruthy();
  });

  it("remembers the plan the lease reports, for the header", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    await launcher.launch(profile("plan"));
    expect(store.readSettings().lastPlan).toBe("free");
    expect(store.readSettings().licenseKey).toBe("cc_lic_test_key"); // nothing else touched
  });

  it("an offline-grace lease (cached token) says nothing new about the plan", async () => {
    store.writeSettings({ licenseKey: "cc_lic_test_key", lastPlan: "pro", crlset: false });
    leaseMock.mockResolvedValue(lease("free", "cached"));
    await launcher.launch(profile("offline"));
    expect(store.readSettings().lastPlan).toBe("pro");
  });

  it("a spawn failure is reported and records no launch", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    spawnMock.mockRejectedValue(new Error("spawn C:\\x\\chrome.exe ENOENT"));
    const r = await launcher.launch(profile("nospawn"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ENOENT/);
    expect(profiles.getProfile("nospawn")?.lastLaunchedAt).toBeUndefined();
  });
});

describe("launch() — the browser's life after it starts", () => {
  const WATCHDOG = "[clearcote] licence: the run-token stopped refreshing (revoked, checked in, or over the concurrency limit); stopping.";

  it("stderr is drained into a tail and stdout ignored — never an unread pipe that can freeze the browser", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    await launcher.launch(profile("pipes"));
    const opts = spawnMock.mock.calls[0][2] as { stdio: unknown };
    expect(opts.stdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  it("a browser that stops on its own is reported, with its stderr tail and the lease's refusal", async () => {
    let child!: ReturnType<typeof fakeChild>;
    spawnMock.mockImplementation(async () => (child = fakeChild()));
    const refusing = { ...lease("free"), refusal: { status: 403, code: "LICENSE_REVOKED" } };
    leaseMock.mockResolvedValue(refusing);
    const events: unknown[] = [];
    const on = (ev: unknown) => events.push(ev);
    launcher.browserEvents.on("exited", on);
    try {
      await launcher.launch(profile("watched"));
      child.stderr.emit("data", Buffer.from("[1:2:INFO:x] starting\n" + WATCHDOG + "\n"));
      child.emit("exit", 0, null);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: "watched", code: 0, signal: null, leaseRefusal: { status: 403, code: "LICENSE_REVOKED" } });
      expect((events[0] as { stderrTail: string }).stderrTail).toContain(WATCHDOG);
      expect(launcher.listRunning()).not.toContain("watched");
    } finally {
      launcher.browserEvents.off("exited", on);
    }
  });

  it("stop() closes it politely, waits for the check-in, and is NOT reported as unexpected", async () => {
    let checkedIn = false;
    const l = {
      ...lease("free"),
      stop: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30));
        checkedIn = true;
      }),
    };
    leaseMock.mockResolvedValue(l);
    const events: unknown[] = [];
    const on = (ev: unknown) => events.push(ev);
    launcher.browserEvents.on("exited", on);
    try {
      await launcher.launch(profile("polite"));
      expect(await launcher.stop("polite")).toBe("graceful");
      expect(stopMock).toHaveBeenCalled();
      expect(checkedIn).toBe(true); // resolved only after the slot was given back
      expect(events).toEqual([]);
      expect(launcher.listRunning()).not.toContain("polite");
      expect(launcher.runningBinaries()).toEqual([]);
    } finally {
      launcher.browserEvents.off("exited", on);
    }
  });

  it("while it runs, its binary is listed as in use (so the cache cleanup never removes it)", async () => {
    leaseMock.mockResolvedValue(lease("free"));
    await launcher.launch(profile("inuse"));
    expect(launcher.runningBinaries()).toEqual([path.join(ROOT, "fake-chrome.exe")]);
  });

  it("stop() on something not running is 'gone' and harmless", async () => {
    expect(await launcher.stop("never-launched")).toBe("gone");
  });
});

describe("launch() — Chrome's revocation list", () => {
  const crlsetFile = path.join(ROOT, "crl-set-fixture");
  beforeEach(() => {
    const header = Buffer.from(JSON.stringify({ ContentType: "CRLSet", Sequence: 10850 }));
    const len = Buffer.alloc(2);
    len.writeUInt16LE(header.length, 0);
    fs.writeFileSync(crlsetFile, Buffer.concat([len, header]));
    process.env.CLEARCOTE_CRLSET_FILE = crlsetFile; // never Google from a unit test
    store.writeSettings({ licenseKey: "cc_lic_test_key" }); // on by default
    leaseMock.mockResolvedValue(lease("pro"));
    holdMock.mockReset();
    holdMock.mockResolvedValue(true);
  });
  afterEach(() => {
    delete process.env.CLEARCOTE_CRLSET_FILE;
  });
  const argv = () => spawnMock.mock.calls[0][1] as string[];

  it("seeds the profile, holds the first tab on about:blank over a pipe, then hands it the start page", async () => {
    const r = await launcher.launch(profile("crl", { startUrl: "example.com" }));
    expect(r).toMatchObject({ ok: true });
    expect((r.warnings ?? []).join(" ")).not.toMatch(/revocation|component-update/);
    expect(argv()).toContain("--remote-debugging-pipe");
    expect(argv()).not.toContain("https://example.com/");
    expect(argv().filter((a) => !a.startsWith("--"))).toEqual(["about:blank"]);
    expect(spawnMock.mock.calls[0][2].stdio).toEqual(["ignore", "ignore", "pipe", "pipe", "pipe"]);
    expect(holdMock.mock.calls[0][2]).toEqual({ url: "https://example.com/" });
    const seeded = path.join(ROOT, "profiles", "crl", "userdata", "CertificateRevocation", "10850", "crl-set");
    expect(fs.existsSync(seeded)).toBe(true);
  });

  it("no start page: the held tab is released to the new-tab page", async () => {
    await launcher.launch(profile("crl-ntp"));
    expect(holdMock.mock.calls[0][2]).toEqual({ newTab: true });
  });

  it("a wait that gives up still launches, and says so", async () => {
    holdMock.mockResolvedValue(false);
    const r = await launcher.launch(profile("crl-slow", { startUrl: "example.com" }));
    expect(r.ok).toBe(true);
    expect(r.warnings?.join(" ")).toMatch(/not confirmed active/);
  });

  it("turned off: no seed, no pipe, the start page on the command line", async () => {
    store.writeSettings({ licenseKey: "cc_lic_test_key", crlset: false });
    await launcher.launch(profile("crl-off", { startUrl: "example.com" }));
    expect(argv()).not.toContain("--remote-debugging-pipe");
    expect(argv().at(-1)).toBe("https://example.com/");
    expect(holdMock).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ROOT, "profiles", "crl-off", "userdata", "CertificateRevocation"))).toBe(false);
  });

  it("a profile that disables the component updater is warned and not held", async () => {
    const r = await launcher.launch(profile("crl-dcu", { extraArgs: ["--disable-component-update"] }));
    expect(r.warnings?.join(" ")).toMatch(/--disable-component-update/);
    expect(argv()).not.toContain("--remote-debugging-pipe");
    expect(holdMock).not.toHaveBeenCalled();
  });

  it("no list to be had: launches without it, with a warning", async () => {
    fs.writeFileSync(crlsetFile, "not a crlset");
    const r = await launcher.launch(profile("crl-bad", { startUrl: "example.com" }));
    expect(r.ok).toBe(true);
    expect(r.warnings?.join(" ")).toMatch(/Could not install Chrome's certificate revocation list/);
    expect(argv().at(-1)).toBe("https://example.com/");
  });
});
