// Captured-profile validation + summary (electron/fpmeta.ts) — the gate every imported or
// library-downloaded fingerprint passes through, and where the screen guard is attached.

import { describe, it, expect } from "vitest";
import { summarizeFingerprint } from "../electron/fpmeta";
import { screenWarningFromLabel } from "../electron/fpargs";

const capture = (over: Record<string, unknown> = {}) => ({
  meta: { id: "donor-01" },
  screen: { width: 2560, height: 1440 },
  hardware_concurrency: 24,
  device_memory: 32,
  webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: "ANGLE (NVIDIA RTX 4070)" } } },
  ...over,
});

describe("summarizeFingerprint — what counts as a capture", () => {
  it("accepts a full capture and pulls out every display field", () => {
    const r = summarizeFingerprint(capture());
    expect(r.ok).toBe(true);
    expect(r.meta).toMatchObject({
      label: "donor-01",
      renderer: "ANGLE (NVIDIA RTX 4070)",
      cores: 24,
      memory: 32,
      screen: "2560x1440",
      screenWidth: 2560,
      screenHeight: 1440,
    });
  });

  // Real captures in the wild predate any schema marker, so identification is structural: any ONE
  // of webgl / screen / hardware_concurrency is enough.
  it("accepts a partial capture carrying any single identifying field", () => {
    expect(summarizeFingerprint({ webgl: {} }).ok).toBe(true);
    expect(summarizeFingerprint({ screen: { width: 1920, height: 1080 } }).ok).toBe(true);
    expect(summarizeFingerprint({ hardware_concurrency: 8 }).ok).toBe(true);
    expect(summarizeFingerprint({ hardware_concurrency: 0 }).ok).toBe(true); // 0 is a value, not absence
  });

  it("rejects anything that isn't a capture, rather than importing junk", () => {
    for (const bad of [null, undefined, 42, "a string", [], {}, { unrelated: true }])
      expect(summarizeFingerprint(bad).ok).toBe(false);
  });

  it("tolerates missing sub-objects without throwing", () => {
    const r = summarizeFingerprint({ screen: {}, webgl: {} });
    expect(r.ok).toBe(true);
    expect(r.meta?.screen).toBeUndefined();
    expect(r.meta?.renderer).toBeUndefined();
    expect(r.meta?.screenWarning).toBeUndefined(); // unknown size ⇒ no claim either way
  });

  it("ignores non-numeric screen values instead of emitting '[object Object]x…'", () => {
    const r = summarizeFingerprint(capture({ screen: { width: "2560", height: null } }));
    expect(r.meta?.screen).toBeUndefined();
    expect(r.meta?.screenWidth).toBeUndefined();
  });
});

describe("summarizeFingerprint — screen guard wiring", () => {
  it("stays silent on a display that can hold a real window", () =>
    expect(summarizeFingerprint(capture()).meta?.screenWarning).toBeUndefined());

  it("warns on a capture too small to contain a browser window", () => {
    const r = summarizeFingerprint(capture({ screen: { width: 1366, height: 768 } }));
    expect(r.ok).toBe(true); // still importable — the user is warned, not blocked
    expect(r.meta?.screenWarning).toMatch(/1366x768/);
  });

  it("catches the headless-720 trap specifically", () =>
    expect(summarizeFingerprint(capture({ screen: { width: 1920, height: 720 } })).meta?.screenWarning)
      .toBeTruthy());
});

describe("screenWarningFromLabel — the curated index's 'WxH' strings", () => {
  it("parses a normal label", () => {
    expect(screenWarningFromLabel("1920x1080")).toBeNull();
    expect(screenWarningFromLabel("1366x768")).toBeTruthy();
  });
  it("says nothing for a missing or unparseable label", () => {
    for (const bad of [undefined, "", "unknown", "1920", "axb"]) expect(screenWarningFromLabel(bad)).toBeNull();
  });
});
