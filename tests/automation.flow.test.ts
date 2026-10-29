// electron/launcher.ts launch() with automation: the local DevTools endpoint the Jet synchronizer attaches to.
// The spawn is stubbed; the stub plays the browser by writing <user-data-dir>/DevToolsActivePort. What it pins:
//   - no automation, no port switch (a launch without it is exactly what it was)
//   - automation adds --remote-debugging-port=0 and reports the endpoint the browser wrote
//   - the "Allow automation" setting turns it on for every launch
//   - a stale port file from an earlier launch is never read as this launch's
//   - the user's own --remote-debugging-port wins; a port that never appears is a warning, not a failure
//   - the endpoint is forgotten when the browser exits

import "./helpers/linux-on-mac"; // pins the Windows/Linux behaviour; a Mac runner runs this suite as Linux
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-auto-"));
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

// The persona step (r51+): recorded, never run, so a fake binary is fine. What the launcher hands it is the point.
const personaMock = vi.fn(async (_bin: string, args: readonly string[], _lease: unknown, _deps?: { env?: NodeJS.ProcessEnv }) => ({
  args: [...args],
  env: (e: NodeJS.ProcessEnv | undefined) => e,
}));
vi.mock("../electron/persona", async (orig) => {
  const real = await orig<typeof import("../electron/persona")>();
  return { ...real, preparePersonaLaunch: (...a: Parameters<typeof personaMock>) => personaMock(...a) };
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


let writePort: ((dir: string) => void) | null = null;

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
  store.writeSettings({ licenseKey: "cc_lic_test_key", crlset: false });
  leaseMock.mockReset();
  leaseMock.mockResolvedValue(lease("free"));
  spawnMock.mockReset();
  writePort = (dir) => fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "51234\n/devtools/browser/abc\n");
  spawnMock.mockImplementation(async (_bin: string, args: string[]) => {
    const dir = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    writePort?.(dir);
    return fakeChild();
  });
});
afterEach(async () => {
  for (const id of launcher.listRunning()) await launcher.stop(id);
});

const profile = (id: string, over: Record<string, unknown> = {}) =>
  profiles.saveProfile({ id, name: id, fingerprint: `seed-${id}`, createdAt: "", updatedAt: "", ...over } as never);
const argsOf = (n = 0) => spawnMock.mock.calls[n][1] as string[];
const userdata = (id: string) => path.join(ROOT, "profiles", id, "userdata");

describe("launch() — automation off", () => {
  it("adds no DevTools port and reports no endpoint", async () => {
    const r = await launcher.launch(profile("plain"));
    expect(r.ok).toBe(true);
    expect(argsOf().some((a) => a.startsWith("--remote-debugging-port"))).toBe(false);
    expect(r.cdp).toBeUndefined();
    expect(launcher.cdpEndpoint("plain")).toBeUndefined();
  });
});

describe("launch() — automation on", () => {
  it("adds --remote-debugging-port=0 and reports the port the browser wrote", async () => {
    const r = await launcher.launch(profile("auto"), undefined, { automation: true });
    expect(r).toMatchObject({ ok: true, cdp: "http://127.0.0.1:51234" });
    expect(argsOf()).toContain("--remote-debugging-port=0");
    expect(launcher.cdpEndpoint("auto")).toBe("http://127.0.0.1:51234");
  });

  it("the Allow automation setting turns it on for every launch", async () => {
    store.writeSettings({ licenseKey: "cc_lic_test_key", crlset: false, automation: true });
    const r = await launcher.launch(profile("setting"));
    expect(argsOf()).toContain("--remote-debugging-port=0");
    expect(r.cdp).toBe("http://127.0.0.1:51234");
  });

  it("removes a stale port file first, so an old launch's port is never reported", async () => {
    fs.mkdirSync(userdata("stale"), { recursive: true });
    fs.writeFileSync(path.join(userdata("stale"), "DevToolsActivePort"), "40000\n/devtools/browser/old\n");
    let sawOld = true;
    writePort = (dir) => {
      // the browser has not written yet when spawn returns: the old file must already be gone
      sawOld = fs.existsSync(path.join(dir, "DevToolsActivePort"));
      setTimeout(() => fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "41111\n/x\n"), 150);
    };
    const r = await launcher.launch(profile("stale"), undefined, { automation: true });
    expect(sawOld).toBe(false);
    expect(r.cdp).toBe("http://127.0.0.1:41111");
  });

  it("the user's own --remote-debugging-port wins: ours is not added", async () => {
    await launcher.launch(profile("own", { extraArgs: ["--remote-debugging-port=9333"] }), undefined, { automation: true });
    const ports = argsOf().filter((a) => a.startsWith("--remote-debugging-port"));
    expect(ports).toEqual(["--remote-debugging-port=9333"]);
  });

  it("a port that never appears is a warning, and the launch still succeeds", async () => {
    writePort = null;
    const r = await launcher.launch(profile("noport"), undefined, { automation: true, portWaitMs: 300 });
    expect(r.ok).toBe(true);
    expect(r.cdp).toBeUndefined();
    expect(r.warnings?.join(" ")).toMatch(/did not open its local automation port/);
  });

  it("forgets the endpoint when the browser exits", async () => {
    await launcher.launch(profile("gone"), undefined, { automation: true });
    expect(launcher.cdpEndpoint("gone")).toBeDefined();
    await launcher.stop("gone");
    expect(launcher.cdpEndpoint("gone")).toBeUndefined();
  });
});
