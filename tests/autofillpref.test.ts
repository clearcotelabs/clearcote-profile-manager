// electron/autofillpref.ts — Chrome's autofill defaults go into a profile's Preferences only where missing.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { seedAutofillPrefs } from "../electron/autofillpref";

let dir: string;
const prefs = () => JSON.parse(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8"));
const write = (v: unknown) => {
  fs.mkdirSync(path.join(dir, "Default"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Default", "Preferences"), typeof v === "string" ? v : JSON.stringify(v));
};
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-autofill-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("seedAutofillPrefs", () => {
  it("a new profile gets both on", () => {
    expect(seedAutofillPrefs(dir)).toEqual(["profile_enabled", "credit_card_enabled"]);
    expect(prefs().autofill).toEqual({ profile_enabled: true, credit_card_enabled: true });
  });
  it("keeps an explicit off and every other preference", () => {
    write({ autofill: { profile_enabled: false, other: 1 }, browser: { x: 2 } });
    expect(seedAutofillPrefs(dir)).toEqual(["credit_card_enabled"]);
    expect(prefs()).toEqual({ autofill: { profile_enabled: false, other: 1, credit_card_enabled: true }, browser: { x: 2 } });
  });
  it("does nothing when both are set, and never replaces a file it cannot read", () => {
    write({ autofill: { profile_enabled: false, credit_card_enabled: false } });
    expect(seedAutofillPrefs(dir)).toEqual([]);
    write("{not json");
    expect(seedAutofillPrefs(dir)).toEqual([]);
    expect(fs.readFileSync(path.join(dir, "Default", "Preferences"), "utf8")).toBe("{not json");
  });
});
