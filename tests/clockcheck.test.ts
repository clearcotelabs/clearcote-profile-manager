// CR-2VFYCD: a computer clock far off makes the engine refuse every token ("no valid license lease for this run");
// the app says the clock is off before launching, and the launch notice says how to fix it.
import { describe, expect, it } from "vitest";
import { ClockSkewError, clockSkewProblem, formatDuration } from "../electron/clockcheck";
import { preparePersonaLaunch } from "../electron/persona";
import { describeLaunchError } from "../src/lib/launchError";

const T = 1_800_000_000; // server time when the token was minted
const tok = (p: Record<string, unknown>) => `${Buffer.from(JSON.stringify(p)).toString("base64url")}.sig`;
const run = tok({ lic: "l", lease: "L1", plan: "free", nbf: T - 900, iat: T, exp: T + 180 });

describe("clockSkewProblem", () => {
  it("is quiet inside the window and names a clock behind or ahead", () => {
    expect(clockSkewProblem(run, T)).toBeNull();
    expect(clockSkewProblem(run, T - 900)).toBeNull();
    expect(clockSkewProblem(run, T - 1200)!.message).toMatch(/clock is at least 20 min behind/);
    expect(clockSkewProblem(run, T + 600)!.message).toMatch(/clock looks wrong/);
    expect(clockSkewProblem("hdr.sig", T)).toBeNull();
    expect(formatDuration(192)).toBe("3 min 12 s");
  });
});

describe("preparePersonaLaunch", () => {
  it("throws ClockSkewError before the host-facts probe runs", async () => {
    let ran = 0;
    const err = await preparePersonaLaunch("chrome", ["--fingerprint=1"], { token: run, leaseId: "L1" }, {
      supports: () => true, runner: () => { ran++; return '{"gpu_vendor":"none"}'; }, fetch: async () => { throw new Error("no fetch"); },
      now: () => T - 3600,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ClockSkewError);
    expect(err.code).toBe("CLOCK_SKEW");
    expect(ran).toBe(0);
  });
});

describe("the launch notice", () => {
  it("a clock behind: says by how much and how to fix it", () => {
    const n = describeLaunchError(`ClockSkewError: ${clockSkewProblem(run, T - 192 - 900)!.message}`);
    expect(n.title).toBe("Your computer's clock is off");
    expect(n.lines[0]).toBe("It runs at least 18 min 12 s behind, so the browser refuses the licence, whichever key you use.");
    expect(n.lines[1]).toMatch(/Set time automatically/);
    expect(n.action).toEqual({ kind: "retry" });
    expect(n.raw).toMatch(/^ClockSkewError: This computer's clock/);
  });

  it("a clock ahead", () => {
    const n = describeLaunchError(clockSkewProblem(run, T + 600, "persona token")!.message);
    expect(n.title).toBe("Your computer's clock is off");
    expect(n.lines[0]).toMatch(/runs ahead of the real time/);
  });
});
