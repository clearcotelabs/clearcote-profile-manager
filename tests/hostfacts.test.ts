// The persona host-facts probe (electron/persona.ts): a probe without output says why, instead of
// "Unexpected end of JSON input" (CR-2VFYCD, r57 on Windows).
import { describe, expect, it, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { clearPersonaCaches, describeProbe, hostFacts } from "../electron/persona";
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
    // An empty LOCALAPPDATA/HOME: the on-disk facts cache would otherwise answer without probing.
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

describe("isWinLaunchRace", () => {
  it("knows the spawnSync wording by its code", () => {
    expect(isWinLaunchRace(Object.assign(new Error("spawnSync C:\\x\\chrome.exe UNKNOWN"), { code: "UNKNOWN" }))).toBe(true);
    expect(isWinLaunchRace(new Error("spawn UNKNOWN"))).toBe(true);
    expect(isWinLaunchRace(Object.assign(new Error("spawnSync x ENOENT"), { code: "ENOENT" }))).toBe(false);
  });
});
