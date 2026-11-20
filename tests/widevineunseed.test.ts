// Unticking "Widevine (DRM)" must take the CDM out of the profile. The engine registers whatever sits
// under <profile>/WidevineCdm at startup, so a profile started once with Widevine on kept DRM after
// the box was unticked (measured on r61: com.widevine.alpha still available two launches later).
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HINT_FILE, unseedWidevine } from "../electron/widevine";

const dirs: string[] = [];
const mk = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-unseed-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("unseedWidevine", () => {
  it("removes a seeded CDM (version folder + hint file) and reports it", () => {
    const prof = mk();
    const wv = path.join(prof, "WidevineCdm");
    fs.mkdirSync(path.join(wv, "4.10.3112.0", "_platform_specific", "win_x64"), { recursive: true });
    fs.writeFileSync(path.join(wv, "4.10.3112.0", "_platform_specific", "win_x64", "widevinecdm.dll"), "x");
    fs.writeFileSync(path.join(wv, HINT_FILE), JSON.stringify({ Path: path.join(wv, "4.10.3112.0") }));
    fs.writeFileSync(path.join(prof, "Local State"), "{}");
    expect(unseedWidevine(prof)).toBe(true);
    expect(fs.existsSync(wv)).toBe(false);
    expect(fs.existsSync(path.join(prof, "Local State"))).toBe(true); // nothing else in the profile is touched
  });

  it("removes a hint file that is there without a version folder", () => {
    const prof = mk();
    fs.mkdirSync(path.join(prof, "WidevineCdm"));
    fs.writeFileSync(path.join(prof, "WidevineCdm", HINT_FILE), "{}");
    expect(unseedWidevine(prof)).toBe(true);
    expect(fs.existsSync(path.join(prof, "WidevineCdm"))).toBe(false);
  });

  it("leaves the empty folder the engine makes itself, and a profile without one", () => {
    const prof = mk();
    expect(unseedWidevine(prof)).toBe(false);
    fs.mkdirSync(path.join(prof, "WidevineCdm"));
    expect(unseedWidevine(prof)).toBe(false);
    expect(fs.existsSync(path.join(prof, "WidevineCdm"))).toBe(true);
  });

  it("never throws on a profile folder that does not exist", () => {
    expect(unseedWidevine(path.join(os.tmpdir(), "ccpm-unseed-missing-" + Date.now()))).toBe(false);
  });
});
