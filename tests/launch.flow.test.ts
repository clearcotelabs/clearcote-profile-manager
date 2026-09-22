// electron/launcher.ts launch() — the bookkeeping around a launch, with the network, the download
// and the spawn stubbed. What it pins:
//   - a licence refusal carries its CODE to the UI (so the card can say what to do about it)
//   - a launch records lastLaunchedAt on the profile AS SAVED NOW, and leaves updatedAt alone —
//     the renderer used to save the copy it held at click time, clobbering edits made during a
//     long first download
//   - the plan a real lease reports is remembered for the header; an offline-grace lease is not

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

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
  const c = new EventEmitter() as EventEmitter & { pid: number; kill: () => void };
  c.pid = 4242;
  c.kill = () => c.emit("exit", 0);
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
  store.writeSettings({ licenseKey: "cc_lic_test_key" });
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
    store.writeSettings({ licenseKey: "cc_lic_test_key", lastPlan: "pro" });
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
