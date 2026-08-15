// The field schema is the editor's contract: every editable setting appears exactly once, in a
// category that exists, and the badge logic answers "what did I set?" rather than "what differs
// from the default". These tests are the guard against the failure mode the schema exists to
// prevent — a new engine switch being added to the Profile type and quietly never rendered.

import { describe, it, expect } from "vitest";
import {
  CATEGORIES,
  FIELDS,
  countSet,
  fieldByKey,
  fieldsIn,
  isFieldSet,
  searchFields,
  type FieldDef,
} from "../src/lib/fields";

const keys = FIELDS.map((f) => f.key);

describe("schema integrity", () => {
  it("every field lands in a category that exists", () => {
    const ids = new Set(CATEGORIES.map((c) => c.id));
    const orphans = FIELDS.filter((f) => !ids.has(f.cat)).map((f) => f.key);
    expect(orphans).toEqual([]);
  });

  it("no field is declared twice", () => {
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it("every category holds at least one field", () => {
    for (const c of CATEGORIES) expect(fieldsIn(c.id).length, `${c.id} is empty`).toBeGreaterThan(0);
  });

  it("every field has a label, and checkboxes explain themselves", () => {
    for (const f of FIELDS) {
      expect(f.label, f.key).toBeTruthy();
      if (f.type === "check") expect(f.desc, `${f.key} has no description`).toBeTruthy();
    }
  });

  it("every select offers options, and its default option is one of them", () => {
    for (const f of FIELDS.filter((x) => x.type === "select")) {
      expect(f.options?.length, `${f.key} has no options`).toBeGreaterThan(0);
      if (f.defaultOption !== undefined) {
        expect(f.options!.map((o) => o.value), `${f.key} default is not an option`).toContain(f.defaultOption);
      }
    }
  });

  it("every custom field names a renderer", () => {
    for (const f of FIELDS.filter((x) => x.type === "custom")) {
      expect(f.custom, `${f.key} is custom but names no renderer`).toBeTruthy();
    }
  });

  it("grouped fields are contiguous, so a group renders as one panel", () => {
    // renderFields() walks the list and closes a group as soon as the next field differs; a split
    // group would silently render as two panels with the same heading.
    const seen = new Set<string>();
    let prev: string | undefined;
    for (const f of FIELDS) {
      if (f.group && f.group !== prev) {
        expect(seen.has(f.group), `${f.group} is split across the list`).toBe(false);
        seen.add(f.group);
      }
      prev = f.group;
    }
  });

  it("only the first member of a group carries the note", () => {
    const byGroup = new Map<string, FieldDef[]>();
    for (const f of FIELDS.filter((x) => x.group)) {
      byGroup.set(f.group!, [...(byGroup.get(f.group!) ?? []), f]);
    }
    for (const [g, members] of byGroup) {
      const withNote = members.filter((m) => m.groupNote);
      expect(withNote.length, `${g} has ${withNote.length} notes`).toBeLessThanOrEqual(1);
      if (withNote.length) expect(withNote[0]).toBe(members[0]);
    }
  });
});

describe("coverage of the Profile type", () => {
  // The whole point of the schema: a setting that exists on a profile but not here is invisible in
  // the UI. This list is the deliberate exclusion set — bookkeeping the editor must never expose.
  const NOT_EDITABLE = [
    "id",
    "createdAt",
    "updatedAt",
    "lastLaunchedAt",
    "fingerprintProfileMeta", // cached display data for fingerprintProfile
  ];

  it("covers every engine switch this session added", () => {
    for (const k of ["portableProfile", "encryptionKey", "shaderDialect", "widevine"]) {
      expect(keys, `${k} is not reachable in the editor`).toContain(k);
    }
  });

  it("covers the settings the old flat editor exposed", () => {
    const old = [
      "name", "fingerprint", "fingerprintProfile", "browserVersion", "platform", "brand", "tlsProfile",
      "timezone", "acceptLanguage", "webrtcIp", "hardwareConcurrency", "geoip", "proxy",
      "fingerprintNoise", "disableGpuFingerprint", "lightStealth", "storageQuota", "webrtcMdns",
      "deviceMemory", "colorDepth", "devicePixelRatio", "maxTouchPoints",
      "screenWidth", "screenHeight", "availWidth", "availHeight",
      "platformVersion", "brandVersion", "gpuVendor", "gpuRenderer",
      "canvasBridgeUrl", "canvasBridgeAuth", "canvasBridgeMode", "canvasBridgeFallback",
      "canvasBridgeAllow", "canvasBridgeDeny", "tags", "group", "notes",
    ];
    for (const k of old) expect(keys, `${k} was dropped in the rewrite`).toContain(k);
  });

  it("does not expose bookkeeping fields", () => {
    for (const k of NOT_EDITABLE) expect(keys, `${k} should not be editable`).not.toContain(k);
  });
});

describe("isFieldSet — 'what did I set', not 'what differs from default'", () => {
  const f = (key: string) => fieldByKey(key)!;

  it("an untouched profile has nothing set", () => {
    const blank = { name: "", fingerprint: "" };
    for (const c of CATEGORIES) expect(countSet(blank, c.id), c.id).toBe(0);
  });

  it("a default brand does not count as set", () => {
    // Brand defaults to Chrome and platform to the host. The user did not choose those, so counting
    // them would make every fresh profile look customised and the badge would answer nothing.
    expect(isFieldSet({}, f("brand"))).toBe(false);
    expect(isFieldSet({ brand: "Edge" }, f("brand"))).toBe(true);
  });

  it("empty string, null and false all read as unset", () => {
    expect(isFieldSet({ timezone: "" }, f("timezone"))).toBe(false);
    expect(isFieldSet({ timezone: null }, f("timezone"))).toBe(false);
    expect(isFieldSet({ widevine: false }, f("widevine"))).toBe(false);
    expect(isFieldSet({ widevine: true }, f("widevine"))).toBe(true);
  });

  it("a numeric 0 counts — a non-touch desktop is a real choice", () => {
    expect(isFieldSet({ maxTouchPoints: 0 }, f("maxTouchPoints"))).toBe(true);
  });

  it("an empty array does not count", () => {
    expect(isFieldSet({ tags: [] }, f("tags"))).toBe(false);
    expect(isFieldSet({ tags: ["us"] }, f("tags"))).toBe(true);
  });

  it("a default-on checkbox counts only when switched OFF", () => {
    // Farbling noise is on unless disabled, so `true` is the default and only `false` is a choice.
    expect(isFieldSet({}, f("fingerprintNoise"))).toBe(false);
    expect(isFieldSet({ fingerprintNoise: true }, f("fingerprintNoise"))).toBe(false);
    expect(isFieldSet({ fingerprintNoise: false }, f("fingerprintNoise"))).toBe(true);
  });

  it("counts per category", () => {
    const p = { proxy: "socks5://h:1", geoip: true, timezone: "Asia/Tokyo" };
    expect(countSet(p, "network")).toBe(3);
    expect(countSet(p, "hardware")).toBe(0);
  });
});

describe("search", () => {
  it("is empty for an empty query, so the panel falls back to the category", () => {
    expect(searchFields("")).toEqual([]);
    expect(searchFields("   ")).toEqual([]);
  });

  it("finds a field by its engine switch name", () => {
    expect(searchFields("socks5").map((f) => f.key)).toContain("proxy");
    expect(searchFields("--fingerprint-location").map((f) => f.key)).toContain("location");
    expect(searchFields("CLEARCOTE_SHADER_DIALECT").map((f) => f.key)).toContain("shaderDialect");
  });

  it("finds a field by a word only its explanation uses", () => {
    expect(searchFields("cdm").map((f) => f.key)).toContain("widevine");
    expect(searchFields("taskbar").map((f) => f.key)).toContain("availWidth");
  });

  it("is case-insensitive and matches the key itself", () => {
    expect(searchFields("WIDEVINE").map((f) => f.key)).toContain("widevine");
    expect(searchFields("canvasBridgeMode").map((f) => f.key)).toContain("canvasBridgeMode");
  });

  it("returns nothing for a term no field mentions", () => {
    expect(searchFields("zzzzz-nothing")).toEqual([]);
  });
});
