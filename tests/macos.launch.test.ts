// electron/launcher.ts launch() on a Mac — the command line and the file actually spawned, with the
// host faked as macOS and the spawn, lease and download stubbed (the launch.flow.test.ts harness).
// What it pins:
//   - a Mac launch carries --use-mock-keychain (the unsigned build would otherwise ask for the
//     "Chromium Safe Storage" keychain item every time), once, and a profile's own copy is not doubled
//   - a profile with no platform claims macos there (the host's own), as on the other OSes
//   - a browser picked as Chromium.app spawns Chromium.app/Contents/MacOS/Chromium (a folder cannot
//     be spawned)
//   - on Windows nothing of this is added (lock)

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-maclaunch-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

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
vi.mock("../electron/procstop", () => ({
  stopGracefully: async (child: EventEmitter & { exitCode: number | null }) => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return "graceful" as const;
  },
}));

type L = typeof import("../electron/launcher");
type P = typeof import("../electron/profiles");
type S = typeof import("../electron/store");
let launcher: L;
let profiles: P;
let store: S;

async function asHost<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const p = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...p, value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", p);
  }
}

function fakeChild() {
  const c = new EventEmitter() as EventEmitter & { pid: number; stderr: EventEmitter; exitCode: number | null };
  c.pid = 4343;
  c.exitCode = null;
  c.stderr = new EventEmitter();
  return c;
}

const APP = path.join(ROOT, "Clearcote", "Chromium.app");
const EXE = path.join(APP, "Contents", "MacOS", "Chromium");
const OLD = { bin: process.env.CLEARCOTE_BINARY };

beforeAll(async () => {
  delete process.env.CLEARCOTE_BINARY;
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  fs.writeFileSync(EXE, "the browser");
  fs.writeFileSync(path.join(APP, "Contents", "Info.plist"), "<key>CFBundleExecutable</key><string>Chromium</string>");
  launcher = await import("../electron/launcher");
  profiles = await import("../electron/profiles");
  store = await import("../electron/store");
});
afterAll(() => {
  if (OLD.bin === undefined) delete process.env.CLEARCOTE_BINARY;
  else process.env.CLEARCOTE_BINARY = OLD.bin;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(ROOT, "profiles"), { recursive: true, force: true });
  // A picked Chromium.app — exactly what the macOS file picker hands back.
  store.writeSettings({ licenseKey: "cc_lic_test_key", binaryPath: APP, crlset: false });
  leaseMock.mockReset();
  leaseMock.mockResolvedValue({ token: "t.sig", leaseId: "L1", bindLaunch: () => ({ path: path.join(ROOT, "tok"), release: () => {} }), stop: async () => {} });
  spawnMock.mockReset();
  spawnMock.mockImplementation(async () => fakeChild());
});
afterEach(async () => {
  await Promise.all(launcher.listRunning().map((id) => launcher.stop(id)));
});

const profile = (id: string, over: Record<string, unknown> = {}) =>
  profiles.saveProfile({ id, name: id, fingerprint: `seed-${id}`, createdAt: "", updatedAt: "", ...over } as never);

describe("launch() on a Mac", () => {
  it("spawns the executable inside the picked Chromium.app", async () => {
    const r = await asHost("darwin", () => launcher.launch(profile("bundle")));
    expect(r.ok).toBe(true);
    expect(spawnMock.mock.calls[0][0]).toBe(EXE);
  });

  it("adds --use-mock-keychain exactly once", async () => {
    await asHost("darwin", () => launcher.launch(profile("keychain")));
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.filter((a) => a === "--use-mock-keychain")).toHaveLength(1);
    // before the start URL, which must stay last
    expect(argv.indexOf("--use-mock-keychain")).toBeLessThan(argv.length);
  });

  it("a profile's own --use-mock-keychain is not doubled", async () => {
    await asHost("darwin", () => launcher.launch(profile("own", { extraArgs: ["--use-mock-keychain"] })));
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.filter((a) => a === "--use-mock-keychain")).toHaveLength(1);
  });

  it("a profile with no platform claims macos — the host's own", async () => {
    await asHost("darwin", () => launcher.launch(profile("noplat")));
    expect(spawnMock.mock.calls[0][1]).toContain("--fingerprint-platform=macos");
  });

  it("the start page stays the last argument", async () => {
    await asHost("darwin", () => launcher.launch(profile("start", { startUrl: "https://example.com/" })));
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv[argv.length - 1]).toBe("https://example.com/");
    expect(argv).toContain("--use-mock-keychain");
  });
});

describe("launch() on Windows (lock)", () => {
  it("no keychain switch, and a Windows persona by default", async () => {
    const exe = path.join(ROOT, "win", "chrome.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "b");
    store.writeSettings({ licenseKey: "cc_lic_test_key", binaryPath: exe, crlset: false });
    await asHost("win32", () => launcher.launch(profile("win")));
    expect(spawnMock.mock.calls[0][0]).toBe(exe);
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv).not.toContain("--use-mock-keychain");
    expect(argv).toContain("--fingerprint-platform=windows");
  });
});

describe("helpers", () => {
  it("explicitBinary resolves a .app from Settings or CLEARCOTE_BINARY, and leaves a file alone", () => {
    expect(launcher.explicitBinary({ binaryPath: APP }, {})).toBe(EXE);
    expect(launcher.explicitBinary({}, { CLEARCOTE_BINARY: APP })).toBe(EXE);
    expect(launcher.explicitBinary({ binaryPath: EXE }, {})).toBe(EXE);
    expect(launcher.explicitBinary({ binaryPath: path.join(ROOT, "gone.app") }, {})).toBeUndefined();
  });

  it("the sibling dev-build layout follows the host", () => {
    expect(launcher.devBuildLayout("win32")).toEqual(["win-x64", "chrome.exe"]);
    expect(launcher.devBuildLayout("linux")).toEqual(["linux-x64", "chrome"]);
    expect(launcher.devBuildLayout("darwin")).toEqual(["macos-arm64", path.join("Chromium.app", "Contents", "MacOS", "Chromium")]);
  });
});
