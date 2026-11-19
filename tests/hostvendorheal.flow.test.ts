// electron/launcher.ts launch(): the engine refuses the persona as "generated for another host GPU vendor"
// (CR-ZQJ4SX: the facts saved on disk said "none", the machine now renders on NVIDIA). The launcher takes the vendor
// the engine named, fetches a persona for it and launches ONCE more. The spawn is stubbed; the stub plays the engine
// by writing its refusal to stderr and exiting. What it pins:
//   - a refusal after launch() returned: one more launch, the first slot checked in before it, no "exited" event
//   - the heal is keyed on the args as they were BEFORE the persona step (a captured profile moves off argv)
//   - a second refusal is reported as before; there is no third launch
//   - any other early exit is reported as before, with no retry
//   - a retry that cannot start reports the refused browser's exit
//   - a refusal while launch() still waits (automation port) returns the retry's browser

import "./helpers/linux-on-mac"; // pins the Windows/Linux behaviour; a Mac runner runs this suite as Linux
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-heal-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

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
  return { ...real, proEnsureBinary: vi.fn(async () => path.join(ROOT, "fake-chrome.exe")) };
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
const stopMock = vi.fn(async (child: EventEmitter & { exitCode: number | null }) => {
  child.exitCode = 0;
  child.emit("exit", 0, null);
  return "graceful" as const;
});
vi.mock("../electron/procstop", () => ({ stopGracefully: (c: never) => stopMock(c) }));

// The persona step plays preparePersonaLaunch's argv change (a captured profile goes, its hash comes) and records
// what it was handed; the heal is the real one, spied on.
const PRE_ONLY = "--fingerprint-profile=cHJvZmlsZQ==";
const personaMock = vi.fn(async (_bin: string, args: readonly string[], _lease: unknown, _deps?: unknown) => ({
  args: args.filter((a) => a !== PRE_ONLY).concat("--fingerprint-profile-sha256=abc"),
  env: (e: NodeJS.ProcessEnv | undefined) => ({ ...e, CLEARCOTE_PERSONA_TOKEN: `tok-${personaMock.mock.calls.length}` }),
}));
const healSpy = vi.fn();
vi.mock("../electron/persona", async (orig) => {
  const real = await orig<typeof import("../electron/persona")>();
  return {
    ...real,
    preparePersonaLaunch: (...a: Parameters<typeof personaMock>) => personaMock(...a),
    healStaleHostVendor: (bin: string, args: readonly string[], text: string) => {
      healSpy(bin, [...args], text);
      return real.healStaleHostVendor(bin, args, text, () => {});
    },
  };
});

type L = typeof import("../electron/launcher");
type P = typeof import("../electron/profiles");
type S = typeof import("../electron/store");
let launcher: L;
let profiles: P;
let store: S;

const STALE = "[clearcote] no usable persona for this run (generated for another host GPU vendor (none, this machine: nvidia)). " +
  "This engine needs a Clearcote SDK, Profile Manager or Helper that fetches personas (r51+).\r\n";

const tokenFor = (plan: string) => `${Buffer.from(JSON.stringify({ plan, lic: "x" })).toString("base64url")}.sig`;
let order: string[];
function lease(n: number) {
  let checkin: Promise<void> | null = null; // like the real LeaseSession: every stop() awaits the same check-in
  return {
    token: tokenFor("free"),
    leaseId: `L${n}`,
    bindLaunch: () => ({ path: path.join(ROOT, "run-token"), release: () => {} }),
    stop: () => (checkin ??= (async () => { await new Promise((r) => setTimeout(r, 10)); order.push(`checkin L${n}`); })()),
  };
}
type Child = EventEmitter & { pid: number; kill: () => void; stderr: EventEmitter; exitCode: number | null };
let children: Child[];
function fakeChild(pid: number): Child {
  const c = new EventEmitter() as Child;
  c.pid = pid;
  c.exitCode = null;
  c.stderr = new EventEmitter();
  c.kill = () => c.emit("exit", 0);
  (c as unknown as { stdio: unknown[] }).stdio = [null, null, c.stderr, new PassThrough(), new PassThrough()];
  return c;
}
/** The engine refusing: its line on stderr, then the exit. */
function refuse(c: Child, text = STALE, code = 13) {
  c.stderr.emit("data", Buffer.from(text));
  c.exitCode = code;
  c.emit("exit", code, null);
}

let exited: Array<{ id: string; stderrTail?: string }>;
const onExited = (ev: { id: string; stderrTail?: string }) => exited.push(ev);

beforeAll(async () => {
  launcher = await import("../electron/launcher");
  profiles = await import("../electron/profiles");
  store = await import("../electron/store");
  launcher.browserEvents.on("exited", onExited);
});
afterAll(() => {
  launcher.browserEvents.off("exited", onExited);
  fs.rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => {
  fs.rmSync(path.join(ROOT, "profiles"), { recursive: true, force: true });
  store.writeSettings({ licenseKey: "cc_lic_test_key", crlset: false });
  order = [];
  children = [];
  exited = [];
  let leases = 0;
  leaseMock.mockReset();
  leaseMock.mockImplementation(async () => { leases++; order.push(`lease L${leases}`); return lease(leases); });
  spawnMock.mockReset();
  spawnMock.mockImplementation(async (_bin: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    order.push(`spawn ${opts.env?.CLEARCOTE_PERSONA_TOKEN}`);
    const c = fakeChild(5000 + children.length);
    children.push(c);
    return c;
  });
  personaMock.mockClear();
  healSpy.mockClear();
});
afterEach(async () => {
  for (const id of launcher.listRunning()) await launcher.stop(id);
});

const profile = (id: string, over: Record<string, unknown> = {}) =>
  profiles.saveProfile({ id, name: id, fingerprint: `seed-${id}`, extraArgs: [PRE_ONLY], createdAt: "", updatedAt: "", ...over } as never);
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("launch() — a persona refused for another host GPU vendor", () => {
  it("launches once more with a persona for the vendor the engine named", async () => {
    const r = await launcher.launch(profile("rdp"));
    expect(r).toMatchObject({ ok: true, pid: 5000 });
    refuse(children[0]);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    await settle();
    // the first slot is checked in before the retry leases one (a one-browser plan)
    expect(order).toEqual(["lease L1", "spawn tok-1", "checkin L1", "lease L2", "spawn tok-2"]);
    expect(exited).toEqual([]); // the card is never told the browser stopped
    expect(launcher.listRunning()).toEqual(["rdp"]);
    // keyed on the args BEFORE the persona step, which the retry hands the persona step again
    const pre = personaMock.mock.calls[0][1];
    expect(pre).toContain(PRE_ONLY);
    expect(healSpy).toHaveBeenCalledTimes(1);
    expect(healSpy.mock.calls[0][1]).toEqual(pre);
    expect(personaMock.mock.calls[1][1]).toEqual(pre);
    // the retry's browser is the profile's now: stopping it stops that one
    expect(await launcher.stop("rdp")).toBe("graceful");
    expect(stopMock.mock.calls.at(-1)?.[0]).toBe(children[1]);
  });

  it("only once: a second refusal is reported as before", async () => {
    await launcher.launch(profile("twice"));
    refuse(children[0]);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    refuse(children[1]);
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(exited).toHaveLength(1);
    expect(exited[0]).toMatchObject({ id: "twice", stderrTail: STALE });
    expect(launcher.listRunning()).toEqual([]);
  });

  it("any other early exit is reported as before, with no retry", async () => {
    await launcher.launch(profile("other"));
    refuse(children[0], "[clearcote] no usable persona for this run (not valid yet).\r\n");
    await settle();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(healSpy).toHaveBeenCalledTimes(1); // asked, and declined
    expect(exited).toHaveLength(1);
    expect(exited[0].stderrTail).toMatch(/not valid yet/);
  });

  it("a retry that cannot start reports the refused browser's exit", async () => {
    await launcher.launch(profile("nolease"));
    leaseMock.mockImplementation(async () => {
      throw Object.assign(new Error("Concurrency limit reached"), { code: "CONCURRENCY_LIMIT_EXCEEDED" });
    });
    refuse(children[0]);
    await vi.waitFor(() => expect(exited).toHaveLength(1));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(exited[0]).toMatchObject({ id: "nolease", stderrTail: STALE });
    expect(launcher.listRunning()).toEqual([]);
    expect((await launcher.launch(profile("nolease"))).ok).toBe(false); // free to launch again (and refused here)
  });

  it("a refusal while launch() still waits returns the retry's browser", async () => {
    let wrote = 0;
    spawnMock.mockImplementation(async (_bin: string, args: string[]) => {
      const c = fakeChild(5000 + children.length);
      children.push(c);
      const dir = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      if (children.length === 1) setTimeout(() => refuse(c), 20); // refused before it writes its port
      else setTimeout(() => { wrote++; fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "51234\n/devtools/browser/x\n"); }, 20);
      return c;
    });
    const r = await launcher.launch(profile("auto"), undefined, { automation: true, portWaitMs: 3000 });
    expect(r).toMatchObject({ ok: true, pid: 5001, cdp: "http://127.0.0.1:51234" });
    expect(r.warnings?.join(" ") ?? "").not.toMatch(/automation port|revocation/);
    expect(wrote).toBe(1);
    expect(exited).toEqual([]);
  });

  it("reads the refusal when the last of stderr arrives after the exit", async () => {
    spawnMock.mockImplementation(async () => {
      const c = fakeChild(5000 + children.length);
      c.stderr = new PassThrough(); // a real stream: "exit" can come before its last data
      children.push(c);
      return c;
    });
    await launcher.launch(profile("late"));
    const err = children[0].stderr as PassThrough;
    children[0].emit("exit", 13, null);
    setTimeout(() => { err.write(STALE); err.end(); }, 20);
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    expect(exited).toEqual([]);
  });

  it("an exit whose stderr ends without the refusal is reported once stderr ends", async () => {
    spawnMock.mockImplementation(async () => {
      const c = fakeChild(5000 + children.length);
      c.stderr = new PassThrough();
      children.push(c);
      return c;
    });
    await launcher.launch(profile("crash"));
    const err = children[0].stderr as PassThrough;
    children[0].emit("exit", 0xc0000005, null);
    expect(exited).toEqual([]); // waiting for the rest of stderr
    err.end("something else\n");
    err.resume();
    await vi.waitFor(() => expect(exited).toHaveLength(1));
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(exited[0].stderrTail).toBe("something else\n");
  });

  it("a launch asked for during the retry is refused as already running", async () => {
    let release!: () => void;
    await launcher.launch(profile("busy"));
    leaseMock.mockImplementation(() => new Promise((res) => { release = () => res(lease(9)); }));
    refuse(children[0]);
    await vi.waitFor(() => expect(leaseMock).toHaveBeenCalledTimes(2));
    expect(await launcher.launch(profile("busy"))).toMatchObject({ ok: false, error: "This profile is already running." });
    release();
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
  });
});
