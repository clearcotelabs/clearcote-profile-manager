// The list's new rules: proxy-list import (bulkCreate.ts), filters, group order and the exit-place
// label (profileList.ts), and exit / swap notices (launchError.ts).

import { describe, it, expect } from "vitest";
import type { Profile } from "../src/types/profile";
import { normalizeProxyLine, profilesFromProxyList } from "../src/lib/bulkCreate";
import { filterProfiles, geoLabel, groupKey, groupProfiles, moveGroup, nextSelection } from "../src/lib/profileList";
import { actionLabel, describeExit, describeLaunchError, withSwap } from "../src/lib/launchError";
import { WATCHDOG_MARKER } from "../electron/exitreason";

const NOW = "2026-09-22T12:00:00.000Z";
const P = (id: string, over: Partial<Profile> = {}): Profile => ({ id, name: id, fingerprint: "s", createdAt: NOW, updatedAt: NOW, ...over });

describe("normalizeProxyLine", () => {
  it("turns the provider format host:port:user:pass into a URL, escaping the credentials", () => {
    expect(normalizeProxyLine("203.0.113.7:3128:alice:s3cret")).toBe("http://alice:s3cret@203.0.113.7:3128");
    expect(normalizeProxyLine("gate.example.net:10000:user-country-us:p@ss:w")).toBe(
      "http://user-country-us:p%40ss%3Aw@gate.example.net:10000",
    );
  });
  it("leaves every other form alone", () => {
    for (const v of ["http://u:p@h:1", "socks5://h:1080", "u:p@h:8080", "h:8080"]) expect(normalizeProxyLine(v)).toBe(v);
  });
});

describe("profilesFromProxyList", () => {
  const deps = (() => {
    let n = 0;
    return { now: NOW, seed: () => `seed${++n}`, suffix: () => `s${n}` };
  })();
  const LIST = [
    "# EU pool",
    "http://u:p@de1.example.net:8080",
    "",
    "socks5://u:p@10.0.0.1:1080",
    "203.0.113.7:3128:alice:s3cret",
    "not a proxy",
    "http://u:p@de1.example.net:8080", // repeat
    "   de2.example.net:9000   ",
  ].join("\n");

  it("one profile per valid, new proxy — comments, blanks, repeats and junk handled", () => {
    const r = profilesFromProxyList(LIST, { namePattern: "EU {n}", geoip: true, group: " Work ", tags: [" eu", ""] }, [], deps);
    expect(r.profiles.map((p) => p.name)).toEqual(["EU 1", "EU 2", "EU 3", "EU 4"]);
    expect(r.profiles.map((p) => p.proxy)).toEqual([
      "http://u:p@de1.example.net:8080",
      "socks5://u:p@10.0.0.1:1080",
      "http://alice:s3cret@203.0.113.7:3128",
      "de2.example.net:9000",
    ]);
    expect(r.duplicates).toBe(1);
    expect(r.invalid).toEqual([{ line: 6, text: "not a proxy" }]);
    const first = r.profiles[0];
    expect(first).toMatchObject({ group: "Work", tags: ["eu"], geoip: true, platform: "windows", createdAt: NOW });
    // Every profile gets its OWN seed.
    expect(new Set(r.profiles.map((p) => p.fingerprint)).size).toBe(4);
  });

  it("names: {host}, a start number, and {n} appended when the pattern has none", () => {
    const one = profilesFromProxyList("h1.example:1\nh2.example:2", { namePattern: "{host}", geoip: false }, [], { now: NOW });
    expect(one.profiles.map((p) => p.name)).toEqual(["h1.example 1", "h2.example 2"]);
    const two = profilesFromProxyList("h:1\nh:2", { namePattern: "Shop {n}", geoip: false, startAt: 10 }, [], { now: NOW });
    expect(two.profiles.map((p) => p.name)).toEqual(["Shop 10", "Shop 11"]);
  });

  it("ids never collide with existing profiles or each other", () => {
    let i = 0;
    const clash = ["dup-aaaa", "dup-aaaa", "dup-bbbb", "dup-cccc"];
    const r = profilesFromProxyList("h:1\nh:2", { namePattern: "Dup", geoip: false }, ["dup-aaaa"], {
      now: NOW,
      suffix: () => clash[i++].slice(4),
    });
    const ids = r.profiles.map((p) => p.id);
    expect(ids).not.toContain("dup-aaaa");
    expect(new Set(ids).size).toBe(2);
  });

  it("an empty paste creates nothing", () => {
    expect(profilesFromProxyList("\n  \n# only a comment", { namePattern: "", geoip: true })).toEqual({ profiles: [], invalid: [], duplicates: 0 });
  });
});

describe("filterProfiles", () => {
  const list = [
    P("a", { name: "Shop", tags: ["EU", "cards"], group: "Work" }),
    P("b", { name: "Bank", tags: ["us"], group: " work" }),
    P("c", { name: "Scratch" }),
    P("d", { name: "Travel", proxy: "http://u:p@de1.example.net:8080", lastGeo: { country: "Germany", countryCode: "DE", city: "Berlin", at: NOW, proxy: "http de1.example.net:8080" } }),
  ];
  const ids = (l: Profile[]) => l.map((p) => p.id);

  it("by tag (case-insensitive), by group (as the list groups them), and running only", () => {
    expect(ids(filterProfiles(list, { tag: "eu" }))).toEqual(["a"]);
    expect(ids(filterProfiles(list, { group: groupKey("WORK") }))).toEqual(["a", "b"]);
    expect(ids(filterProfiles(list, { group: "" }))).toEqual(["c", "d"]); // no group
    expect(ids(filterProfiles(list, { runningOnly: true }, ["b", "d"]))).toEqual(["b", "d"]);
  });
  it("filters combine, and the search reaches the exit place and the proxy host", () => {
    expect(ids(filterProfiles(list, { query: "berlin" }))).toEqual(["d"]);
    expect(ids(filterProfiles(list, { query: "de1.example" }))).toEqual(["d"]);
    expect(ids(filterProfiles(list, { query: "s", tag: "cards", group: "work" }))).toEqual(["a"]);
    expect(ids(filterProfiles(list, {}))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("group order", () => {
  const list = [P("1", { group: "Alpha" }), P("2", { group: "Beta" }), P("3"), P("4", { group: "Gamma" })];

  it("a saved order wins; groups not in it follow in appearance order; 'No group' stays last", () => {
    expect(groupProfiles(list, ["gamma", "alpha"]).map((s) => s.key)).toEqual(["gamma", "alpha", "beta", ""]);
    expect(groupProfiles(list).map((s) => s.group)).toEqual(["Alpha", "Beta", "Gamma", null]);
  });
  it("moveGroup swaps a group with its neighbour, and ignores the ends and 'No group'", () => {
    expect(moveGroup(["alpha", "beta", "gamma", ""], "beta", -1)).toEqual(["beta", "alpha", "gamma"]);
    expect(moveGroup(["alpha", "beta", "gamma", ""], "gamma", 1)).toEqual(["alpha", "beta", "gamma"]);
    expect(moveGroup(["alpha", "beta"], "zeta", 1)).toEqual(["alpha", "beta"]);
  });
});

describe("geoLabel", () => {
  const proxy = "http://u:p@de1.example.net:8080";
  const geo = { ip: "198.51.100.4", country: "Germany", countryCode: "DE", city: "Berlin", at: "2026-09-22T10:00:00.000Z", proxy: "http de1.example.net:8080" };

  it("shows city and country, with the exit IP and the age in the tooltip", () => {
    const l = geoLabel(P("x", { proxy, lastGeo: geo }), Date.parse(NOW))!;
    expect(l.text).toBe("Berlin, DE");
    expect(l.title).toBe("Exits via http de1.example.net:8080 as 198.51.100.4 (Germany), checked 2 hours ago.");
  });
  it("an answer measured for a DIFFERENT proxy is not shown", () => {
    expect(geoLabel(P("x", { proxy: "http://u:p@other.example:8080", lastGeo: geo }))).toBeNull();
    expect(geoLabel(P("x", { lastGeo: geo }))).toBeNull(); // proxy removed since
    expect(geoLabel(P("x", { proxy }))).toBeNull(); // never measured
  });
});

describe("describeExit — the card's words for a browser that stopped on its own", () => {
  it("closed from its own window: nothing to say", () => {
    expect(describeExit({ code: 0, signal: null })).toBeNull();
  });

  it("the licence watchdog, with the server's reason when a heartbeat was refused", () => {
    const tail = `${WATCHDOG_MARKER} (revoked, checked in, or over the concurrency limit); stopping.`;
    const over = describeExit({ code: 0, signal: null, stderrTail: tail, leaseRefusal: { status: 429, code: "CONCURRENCY_LIMIT_EXCEEDED" } })!;
    expect(over.title).toBe("Closed by the licence check");
    expect(over.lines).toEqual(["Another browser took this licence's only slot."]);
    expect(over.action).toEqual({ kind: "retry" });
    const revoked = describeExit({ code: 0, signal: null, stderrTail: tail, leaseRefusal: { status: 403, code: "LICENSE_REVOKED", error: "This license was revoked." } })!;
    expect(revoked.lines).toEqual(["This license was revoked."]);
    expect(revoked.action).toEqual({ kind: "settings", section: "license" });
    const unknown = describeExit({ code: 0, signal: null, stderrTail: tail })!;
    expect(unknown.lines[0]).toMatch(/a few minutes after the app is closed/);
    expect(unknown.raw).toContain(WATCHDOG_MARKER); // "Copy details" has the engine's own words
  });

  it("a crash names the code; ended from outside says so", () => {
    const crash = describeExit({ code: 3221225477, signal: null, stderrTail: "[1:2:ERROR:x.cc(1)] boom\n" })!;
    expect(crash.tone).toBe("error");
    expect(crash.lines[0]).toBe("Access violation — 0xC0000005. The profile's data is not affected; launch it again.");
    expect(describeExit({ code: 1, signal: null })!.title).toBe("Closed from outside the app");
  });

  it("anything else quotes the browser's last line", () => {
    const n = describeExit({ code: 7, signal: null, stderrTail: "first\n\n  the last thing it said  \n\n" })!;
    expect(n.title).toBe("The browser stopped unexpectedly");
    expect(n.lines).toEqual(["It ended with exit code 7.", "Its last message: the last thing it said"]);
  });
});

describe("withSwap — one-browser plan", () => {
  const limit = describeLaunchError("Concurrency limit reached.", "CONCURRENCY_LIMIT_EXCEEDED");

  it("offers to stop the one other running profile", () => {
    const n = withSwap(limit, "CONCURRENCY_LIMIT_EXCEEDED", [{ id: "shop", name: "Shop" }]);
    expect(n.action).toEqual({ kind: "swap", stopId: "shop", stopName: "Shop" });
    expect(actionLabel(n.action!)).toBe("Stop “Shop” and launch");
  });
  it("not with several running (which to close is the person's call), nor for other errors", () => {
    expect(withSwap(limit, "CONCURRENCY_LIMIT_EXCEEDED", [{ id: "a", name: "A" }, { id: "b", name: "B" }]).action).toEqual({ kind: "retry" });
    expect(withSwap(limit, "CONCURRENCY_LIMIT_EXCEEDED", []).action).toEqual({ kind: "retry" });
    const other = describeLaunchError("fetch failed");
    expect(withSwap(other, undefined, [{ id: "a", name: "A" }])).toBe(other);
  });
});

describe("nextSelection — click and Shift+click", () => {
  const order = ["shop", "bank", "mail", "temp"];

  it("a click toggles one profile", () => {
    const one = nextSelection(new Set(), "bank", { range: false, from: null, order });
    expect([...one]).toEqual(["bank"]);
    expect([...nextSelection(one, "bank", { range: false, from: "bank", order })]).toEqual([]);
  });
  it("Shift+click selects everything shown between the last click and this one, either direction", () => {
    expect([...nextSelection(new Set(["shop"]), "mail", { range: true, from: "shop", order })].sort()).toEqual(["bank", "mail", "shop"]);
    expect([...nextSelection(new Set(), "bank", { range: true, from: "temp", order })].sort()).toEqual(["bank", "mail", "temp"]);
  });
  it("Shift+click with no usable anchor (none yet, or it is filtered away) toggles just that profile", () => {
    expect([...nextSelection(new Set(), "mail", { range: true, from: null, order })]).toEqual(["mail"]);
    expect([...nextSelection(new Set(), "mail", { range: true, from: "gone", order })]).toEqual(["mail"]);
  });
  it("never mutates the previous selection", () => {
    const prev = new Set(["shop"]);
    nextSelection(prev, "temp", { range: true, from: "shop", order });
    expect([...prev]).toEqual(["shop"]);
  });
});
