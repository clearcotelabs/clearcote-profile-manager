// src/lib/profileList.ts — ordering, grouping and the short facts a card shows.

import { describe, it, expect } from "vitest";
import type { Profile } from "../src/types/profile";
import {
  displayName,
  groupProfiles,
  isProfileDirty,
  pinRefusedOnFree,
  proxySummary,
  relativeTime,
  sortProfiles,
  versionInfo,
} from "../src/lib/profileList";

const P = (id: string, over: Partial<Profile> = {}): Profile => ({
  id,
  name: id,
  fingerprint: `seed-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const ids = (l: Profile[]) => l.map((p) => p.id);

describe("sortProfiles", () => {
  const a = P("a", { name: "Alpha", updatedAt: "2026-09-01T00:00:00Z", createdAt: "2026-03-01T00:00:00Z" });
  const b = P("b", { name: "beta", lastLaunchedAt: "2026-09-20T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" });
  const c = P("c", { name: "Gamma 10", updatedAt: "2026-09-10T00:00:00Z", createdAt: "2026-06-01T00:00:00Z" });
  const d = P("d", { name: "Gamma 9", updatedAt: "2026-02-01T00:00:00Z", createdAt: "2026-05-01T00:00:00Z" });
  const all = [a, b, c, d];

  it("recent: the latest of last launch and last edit, newest first", () => {
    expect(ids(sortProfiles(all, [], "recent"))).toEqual(["b", "c", "a", "d"]);
  });

  it("recent: running profiles come first, still in recency order among themselves", () => {
    expect(ids(sortProfiles(all, ["d", "a"], "recent"))).toEqual(["a", "d", "b", "c"]);
  });

  it("name: case-insensitive and numeric-aware (Gamma 9 before Gamma 10), running ignored", () => {
    expect(ids(sortProfiles(all, ["d"], "name"))).toEqual(["a", "b", "d", "c"]);
  });

  it("created: newest first", () => {
    expect(ids(sortProfiles(all, [], "created"))).toEqual(["c", "d", "a", "b"]);
  });

  it("never mutates the input, and ties fall back to the name", () => {
    const input = [P("z"), P("y")];
    const out = sortProfiles(input, [], "recent");
    expect(ids(input)).toEqual(["z", "y"]);
    expect(ids(out)).toEqual(["y", "z"]);
  });

  it("a missing or broken timestamp sorts as oldest instead of throwing", () => {
    const junk = P("j", { updatedAt: "not a date", createdAt: "" });
    expect(ids(sortProfiles([junk, a], [], "recent"))).toEqual(["a", "j"]);
  });
});

describe("groupProfiles", () => {
  it("no groups at all → one unnamed section, order kept", () => {
    expect(groupProfiles([P("a"), P("b")])).toEqual([{ group: null, profiles: [P("a"), P("b")] }]);
  });

  it("groups in order of first appearance, ungrouped last, case/space-insensitive", () => {
    const list = [
      P("1", { group: "Work" }),
      P("2"),
      P("3", { group: "shops" }),
      P("4", { group: " work " }),
      P("5", { group: "" }),
    ];
    const s = groupProfiles(list);
    expect(s.map((x) => x.group)).toEqual(["Work", "shops", null]);
    expect(s.map((x) => ids(x.profiles))).toEqual([["1", "4"], ["3"], ["2", "5"]]);
  });

  it("only named groups → no empty 'No group' section", () => {
    expect(groupProfiles([P("1", { group: "g" })]).map((x) => x.group)).toEqual(["g"]);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-09-22T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it("reads naturally at each scale", () => {
    expect(relativeTime(ago(10_000), now)).toBe("just now");
    expect(relativeTime(ago(5 * MIN), now)).toBe("5 minutes ago");
    expect(relativeTime(ago(2 * HOUR), now)).toBe("2 hours ago");
    expect(relativeTime(ago(DAY), now)).toBe("yesterday");
    expect(relativeTime(ago(3 * DAY), now)).toBe("3 days ago");
    expect(relativeTime(ago(14 * DAY), now)).toBe("2 weeks ago");
  });

  it("falls back to a date for old launches, and to null for nothing", () => {
    expect(relativeTime(ago(90 * DAY), now)).toMatch(/2026/);
    expect(relativeTime(undefined, now)).toBeNull();
    expect(relativeTime("garbage", now)).toBeNull();
  });

  it("a clock slightly ahead (future timestamp) is 'just now', not '-1 minutes'", () => {
    expect(relativeTime(new Date(now + 20_000).toISOString(), now)).toBe("just now");
  });
});

describe("versionInfo", () => {
  it("labels latest, a major, and an exact pin", () => {
    for (const v of [undefined, "", "latest", "LATEST", "auto"]) expect(versionInfo(v)).toEqual({ kind: "latest", label: "latest build" });
    expect(versionInfo("153")).toEqual({ kind: "major", label: "build 153" });
    expect(versionInfo("151.0.7922.108-r18")).toEqual({ kind: "exact", label: "pinned 151.0.7922.108-r18" });
    expect(versionInfo("r27")).toEqual({ kind: "exact", label: "pinned r27" });
  });
});

describe("pinRefusedOnFree — mirrors what /download/pro serves a free key", () => {
  const current = { version: "153.0.8010.36", major: 153 };

  it("latest is always fine", () => {
    expect(pinRefusedOnFree(undefined, current)).toBe(false);
    expect(pinRefusedOnFree("latest", current)).toBe(false);
  });

  it("naming the current build is fine (major, version, version-revision, tag)", () => {
    for (const v of ["153", "153.0.8010.36", "153.0.8010.36-r27", "pro-153.0.8010.36-r27"]) {
      expect(pinRefusedOnFree(v, current), v).toBe(false);
    }
  });

  it("anything older is refused", () => {
    for (const v of ["152", "151.0.7922.108-r18", "152.0.7977.82"]) {
      expect(pinRefusedOnFree(v, current), v).toBe(true);
    }
  });

  it("no verdict while the current build is unknown — never warn on a guess", () => {
    expect(pinRefusedOnFree("151.0.7922.108-r18", undefined)).toBe(false);
    expect(pinRefusedOnFree("151.0.7922.108-r18", {})).toBe(false);
  });
});

describe("proxySummary", () => {
  it("shows scheme, host and port — never the credentials", () => {
    expect(proxySummary("http://alice:s3cret@proxy.example:8080")).toBe("http proxy.example:8080");
    expect(proxySummary("socks5://u:p@10.0.0.1:1080")).toBe("socks5 10.0.0.1:1080");
    expect(proxySummary("host.example:3128")).toBe("http host.example:3128");
    expect(proxySummary("http://alice:s3cret@proxy.example:8080")).not.toMatch(/alice|s3cret/);
  });

  it("nothing usable → null", () => {
    expect(proxySummary(undefined)).toBeNull();
    expect(proxySummary("")).toBeNull();
  });
});

describe("isProfileDirty", () => {
  const base = P("x", { tags: ["a"], geoip: true });

  it("an unchanged copy is clean, whatever the key order", () => {
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as Profile;
    expect(isProfileDirty(reordered, base)).toBe(false);
  });

  it("round-trip noise is not a change: emptied strings, emptied tag lists, undefined keys", () => {
    const orig = P("x");
    expect(isProfileDirty({ ...orig, tags: [] }, orig)).toBe(false);
    expect(isProfileDirty({ ...orig, notes: "" }, orig)).toBe(false);
    expect(isProfileDirty({ ...orig, timezone: undefined }, orig)).toBe(false);
  });

  it("a real edit is a change", () => {
    expect(isProfileDirty({ ...base, name: "renamed" }, base)).toBe(true);
    expect(isProfileDirty({ ...base, tags: ["a", "b"] }, base)).toBe(true);
    expect(isProfileDirty({ ...base, geoip: false }, base)).toBe(true);
    expect(isProfileDirty({ ...base, maxTouchPoints: 0 }, base)).toBe(true); // 0 is a value, not "empty"
  });
});

describe("displayName", () => {
  it("falls back to the id for an unnamed profile", () => {
    expect(displayName(P("abc", { name: "  " }))).toBe("abc");
    expect(displayName(P("abc", { name: "Shop" }))).toBe("Shop");
  });
});
