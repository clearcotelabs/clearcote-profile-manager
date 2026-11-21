// From Chromium 158 a profile's second start opens a window-sized "make this your default browser" dialog unless
// the launch carries --no-default-browser-check. Every profile launch carries it, once.
import "./helpers/linux-on-mac"; // pins the Windows/Linux behaviour; a Mac runner runs this suite as Linux
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultBrowserArgs, NO_DEFAULT_BROWSER_CHECK_SWITCH } from "../electron/fpargs";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-defbrowser-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const profile = { id: "p", name: "p", fingerprint: "s1", createdAt: "", updatedAt: "" };
const count = (args: string[]) => args.filter((a) => a === NO_DEFAULT_BROWSER_CHECK_SWITCH).length;

describe("the default-browser prompt", () => {
  it("is switched off by one switch", () => {
    expect(NO_DEFAULT_BROWSER_CHECK_SWITCH).toBe("--no-default-browser-check");
    expect(defaultBrowserArgs()).toEqual(["--no-default-browser-check"]);
    expect(defaultBrowserArgs(["--lang=fi"])).toEqual(["--no-default-browser-check"]);
  });
  it("is not added twice when the profile's extra flags already have it", () => {
    expect(defaultBrowserArgs(["--no-default-browser-check"])).toEqual([]);
  });
  it("is on every profile launch, exactly once", async () => {
    const { buildArgs } = await import("../electron/launcher");
    expect(count(buildArgs(profile as never, "C:/udd"))).toBe(1);
    expect(count(buildArgs({ ...profile, extraArgs: ["--no-default-browser-check"] } as never, "C:/udd"))).toBe(1);
    expect(count(buildArgs({ ...profile, platform: "linux", startUrl: "https://example.com/" } as never, "C:/udd"))).toBe(1);
  });
  it("leaves the first-run switch alone", async () => {
    const { buildArgs } = await import("../electron/launcher");
    expect(buildArgs(profile as never, "C:/udd")).not.toContain("--no-first-run");
  });
});
