// The persona host-facts probe (electron/persona.ts): a probe without output says why, instead of
// "Unexpected end of JSON input" (CR-2VFYCD, r57 on Windows). Its answer is kept in memory only, and an engine
// refusal for "another host GPU vendor" heals it once (CR-ZQJ4SX).
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  TOKEN_ENV, clearPersonaCaches, describeProbe, healStaleHostVendor, hostFacts, preparePersonaLaunch, staleHostVendor,
  type HostFacts, type Selector,
} from "../electron/persona";
import { isWinLaunchRace } from "../electron/winlaunch";

const LICENCE_REFUSAL = "[clearcote] no valid license lease for this run. Set a license key (CLEARCOTE_LICENSE_KEY) via the SDK and check your plan's concurrency limit.\r\n";

describe("describeProbe", () => {
  it("returns stdout of a clean run", () => {
    expect(describeProbe({ stdout: '{"gpu_vendor":"nvidia"}\n', stderr: "", status: 0 })).toContain("nvidia");
  });

  it("names the engine's refusal from stderr", () => {
    expect(() => describeProbe({ stdout: "", stderr: LICENCE_REFUSAL, status: 1 }))
      .toThrow("it exited with code 1: no valid license lease for this run.");
  });

  it("names a binary that could not start", () => {
    const error = Object.assign(new Error("spawnSync C:\\x\\chrome.exe UNKNOWN"), { code: "UNKNOWN" });
    expect(() => describeProbe({ stdout: null, stderr: null, status: null, error }))
      .toThrow("it could not be started: spawnSync C:\\x\\chrome.exe UNKNOWN");
  });

  it("names a timeout", () => {
    const error = Object.assign(new Error("spawnSync chrome.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(() => describeProbe({ stdout: "", stderr: "", status: null, signal: "SIGTERM", error })).toThrow("did not answer within 30 s");
  });

  it("names a clean exit with no output", () => {
    expect(() => describeProbe({ stdout: "  \n", stderr: "", status: 0 })).toThrow("it exited without output");
  });
});

describe("hostFacts", () => {
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    clearPersonaCaches();
    // A LOCALAPPDATA/HOME of its own, so nothing here ever touches the real ones.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostfacts-"));
    env = { LOCALAPPDATA: dir, HOME: dir };
  });

  it("carries the reason into the launch error", () => {
    const runner = () => describeProbe({ stdout: "", stderr: LICENCE_REFUSAL, status: 1 });
    expect(() => hostFacts("chrome-missing.exe", [], "tok", runner, env))
      .toThrow("the engine did not report its host facts (it exited with code 1: no valid license lease for this run.");
  });

  it("parses the last stdout line", () => {
    expect(hostFacts("chrome-missing.exe", [], "tok", () => "log line\n{\"gpu_vendor\":\"amd\"}\n", env)).toEqual({ gpu_vendor: "amd" });
  });
});

// --- CR-ZQJ4SX: a stale host GPU vendor ------------------------------------------------------------------------------

// The customer's engine stderr, as the launcher's tail holds it.
const STALE = "[clearcote] no usable persona for this run (generated for another host GPU vendor (none, this machine: nvidia)). " +
  "This engine needs a Clearcote SDK, Profile Manager or Helper that fetches personas (r51+).\r\n";

describe("host facts are not kept on disk", () => {
  let dir: string;
  let bin: string;
  beforeEach(() => {
    clearPersonaCaches();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostfacts-disk-"));
    bin = path.join(dir, "chrome.exe");
    fs.writeFileSync(bin, "x");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("an old persona-host-facts.json saying \"none\" is neither read nor rewritten: the engine is asked", () => {
    // Up to 0.42.0 a saved answer was never checked again: a "none" saved before the NVIDIA driver (or in a Remote
    // Desktop session) failed every later launch.
    const old = path.join(dir, ".clearcote", "persona-host-facts.json");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    const st = fs.statSync(bin);
    const key = JSON.stringify([path.resolve(bin), st.size, Math.floor(st.mtimeMs / 1000), []]);
    const text = JSON.stringify({ [key]: { gpu_vendor: "none" } });
    fs.writeFileSync(old, text);
    const read = vi.spyOn(fs, "readFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const exists = vi.spyOn(fs, "existsSync");
    let probes = 0;
    const runner = () => { probes++; return '{"gpu_vendor":"nvidia"}'; };
    expect(hostFacts(bin, [], "tok", runner, { LOCALAPPDATA: dir, HOME: dir })).toEqual({ gpu_vendor: "nvidia" });
    expect(probes).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(exists).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(fs.readFileSync(old, "utf8")).toBe(text); // left alone
    expect(fs.readdirSync(path.dirname(old))).toEqual(["persona-host-facts.json"]);
  });

  it("asks once per process (in memory), and again in a new one", () => {
    let probes = 0;
    const runner = () => { probes++; return '{"gpu_vendor":"amd"}'; };
    const env = { LOCALAPPDATA: dir, HOME: dir };
    hostFacts(bin, ["--headless"], "tok", runner, env);
    hostFacts(bin, ["--headless"], "tok", runner, env);
    expect(probes).toBe(1);
    clearPersonaCaches(); // what a new process starts with
    hostFacts(bin, ["--headless"], "tok", runner, env);
    expect(probes).toBe(2);
  });
});

describe("staleHostVendor", () => {
  it("reads the engine's refusal", () => {
    expect(staleHostVendor(STALE)).toEqual({ was: "none", now: "nvidia" });
    expect(staleHostVendor("x (generated for another host GPU vendor (?, this machine: amd)) y")).toEqual({ was: "?", now: "amd" });
    expect(staleHostVendor("(generated for another host GPU vendor (, this machine: none))")).toEqual({ was: "", now: "none" });
  });

  it("ignores everything else", () => {
    expect(staleHostVendor("[clearcote] no usable persona for this run (not valid yet).")).toBeNull();
    expect(staleHostVendor(LICENCE_REFUSAL)).toBeNull();
    expect(staleHostVendor("generated for another host GPU vendor")).toBeNull();
    expect(staleHostVendor("")).toBeNull();
    expect(staleHostVendor(undefined)).toBeNull();
  });
});

describe("healStaleHostVendor", () => {
  let dir: string;
  let bin: string;
  let probes: string[][];
  let fetched: HostFacts[];
  // The probe keeps answering "none" (adapter 0 is the Remote Display Adapter): the heal must not depend on it.
  const runner = (cmd: string[]) => { probes.push(cmd); return '{"gpu_vendor":"none"}'; };
  const fetch = async (_run: string, _sel: Selector, host: HostFacts) => {
    fetched.push(host);
    return { token: `tok-${host.gpu_vendor}`, exp: Date.now() / 1000 + 3600 };
  };
  const lease = { token: "hdr.sig", leaseId: "L1" };
  const deps = () => ({ supports: () => true, runner, fetch, env: { LOCALAPPDATA: dir, HOME: dir } });

  beforeEach(() => {
    clearPersonaCaches();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hostfacts-heal-"));
    bin = path.join(dir, "chrome.exe");
    fs.writeFileSync(bin, "x");
    probes = [];
    fetched = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("takes the vendor the engine named: the next launch fetches {gpu_vendor: nvidia} without probing again", async () => {
    const profile = Buffer.from(JSON.stringify({ screen: { width: 1920 } })).toString("base64");
    // As the launcher has them BEFORE the persona step: a captured profile still on them.
    const args = ["--fingerprint=3", "--headless", `--fingerprint-profile=${profile}`];
    const first = await preparePersonaLaunch(bin, args, lease, deps());
    expect(first.env({})?.[TOKEN_ENV]).toBe("tok-none");
    expect(probes).toEqual([[bin, "--cc-persona-host-facts", "--headless"]]);

    const logged: string[] = [];
    expect(healStaleHostVendor(bin, args, STALE, (l) => logged.push(l))).toBe(true);
    expect(logged).toEqual([expect.stringContaining("(none -> nvidia)")]);

    const again = await preparePersonaLaunch(bin, args, lease, deps());
    expect(again.env({})?.[TOKEN_ENV]).toBe("tok-nvidia"); // a new token: the cached one was for "none"
    expect(fetched).toEqual([{ gpu_vendor: "none" }, { gpu_vendor: "nvidia" }]);
    expect(probes).toHaveLength(1); // the engine's own answer was used
    expect(again.args).toEqual(first.args);
  });

  it("changes nothing for any other failure", async () => {
    const args = ["--fingerprint=3"];
    await preparePersonaLaunch(bin, args, lease, deps());
    const logged: string[] = [];
    expect(healStaleHostVendor(bin, args, LICENCE_REFUSAL, (l) => logged.push(l))).toBe(false);
    expect(healStaleHostVendor(bin, args, "", (l) => logged.push(l))).toBe(false);
    expect(logged).toEqual([]);
    await preparePersonaLaunch(bin, args, lease, deps());
    expect(fetched).toEqual([{ gpu_vendor: "none" }]); // the cached token, for the cached facts
    expect(probes).toHaveLength(1);
  });
});

describe("isWinLaunchRace", () => {
  it("knows the spawnSync wording by its code", () => {
    expect(isWinLaunchRace(Object.assign(new Error("spawnSync C:\\x\\chrome.exe UNKNOWN"), { code: "UNKNOWN" }))).toBe(true);
    expect(isWinLaunchRace(new Error("spawn UNKNOWN"))).toBe(true);
    expect(isWinLaunchRace(Object.assign(new Error("spawnSync x ENOENT"), { code: "ENOENT" }))).toBe(false);
  });
});
