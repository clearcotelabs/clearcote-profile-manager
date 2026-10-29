import { describe, it, expect } from "vitest";
import type { Profile } from "@/types/profile";
import { attentionReasons, inView, personaLabel, proxyInventory, replaceProxy, tagCounts } from "@/lib/workspace";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const p = (id: string, over: Partial<Profile> = {}): Profile => ({
  id,
  name: id,
  fingerprint: `seed-${id}`,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  widevine: true,
  ...over,
});

describe("views", () => {
  const active = new Set(["a"]);
  const attention = new Set(["b"]);
  it("running, attention and all", () => {
    expect(inView(p("a"), "running", { active, attention })).toBe(true);
    expect(inView(p("b"), "running", { active, attention })).toBe(false);
    expect(inView(p("b"), "attention", { active, attention })).toBe(true);
    expect(inView(p("c"), "all", { active, attention })).toBe(true);
  });
  it("used this week = launched in the last 7 days, never launched is not", () => {
    const o = { active, attention, now: NOW };
    expect(inView(p("x", { lastLaunchedAt: "2026-10-27T12:00:00Z" }), "recent", o)).toBe(true);
    expect(inView(p("x", { lastLaunchedAt: "2026-10-20T12:00:00Z" }), "recent", o)).toBe(false);
    expect(inView(p("x"), "recent", o)).toBe(false);
  });
});

describe("attention", () => {
  it("a notice comes first, then coherence errors with their field", () => {
    const bad = p("x", { widevine: false }); // Chrome brand without Widevine is an error
    const r = attentionReasons(bad, { tone: "error", title: "The browser crashed" });
    expect(r[0].text).toBe("The browser crashed");
    expect(r.some((x) => x.field === "widevine")).toBe(true);
  });
  it("a clean profile needs nothing", () => {
    expect(attentionReasons(p("ok"), undefined)).toEqual([]);
  });
});

describe("proxy inventory", () => {
  const list = [
    p("one", { proxy: "socks5://u1:pw@10.0.0.1:1080", lastGeo: { proxy: "socks5 10.0.0.1:1080", at: "2026-10-28T00:00:00Z", city: "Berlin" } }),
    p("two", { proxy: "10.0.0.1:1080:u2:pw", lastGeo: { proxy: "socks5 10.0.0.1:1080", at: "2026-10-29T00:00:00Z", city: "Munich" } }),
    p("three", { proxy: "socks5://u2:pw@10.0.0.1:1080" }),
    p("four", { proxy: "http://1.2.3.4:8080" }),
    p("none"),
  ];
  it("groups by scheme host:port whatever the login, biggest first", () => {
    const rows = proxyInventory(list);
    // "two" has no scheme, so it is http — a different proxy from the socks5 one
    const socks = rows.find((r) => r.key === "socks5 10.0.0.1:1080")!;
    expect(socks.profiles.map((x) => x.id)).toEqual(["one", "three"]);
    expect(socks.auth).toBe(true);
    expect(rows[0]).toBe(socks);
    expect(rows.find((r) => r.key === "http 1.2.3.4:8080")!.auth).toBe(false);
    expect(rows.some((r) => r.profiles.some((x) => x.id === "none"))).toBe(false);
  });
  it("keeps the newest exit measured through that proxy only", () => {
    const rows = proxyInventory(list);
    expect(rows.find((r) => r.key === "socks5 10.0.0.1:1080")!.lastGeo?.city).toBe("Berlin");
  });
  it("replace keeps each profile's own login unless the new one has its own", () => {
    const a = replaceProxy(list[0], "socks5 10.0.0.1:1080", "socks5://10.0.0.9:2000");
    expect(a.proxy).toBe("socks5://u1:pw@10.0.0.9:2000");
    const b = replaceProxy(list[0], "socks5 10.0.0.1:1080", "socks5://new:np@10.0.0.9:2000");
    expect(b.proxy).toBe("socks5://new:np@10.0.0.9:2000");
    expect(replaceProxy(list[3], "socks5 10.0.0.1:1080", "socks5://10.0.0.9:2000")).toBe(list[3]);
  });
});

describe("labels", () => {
  it("persona and tags", () => {
    expect(personaLabel(p("x", { platform: "windows", brand: "Edge", brandVersion: "156.0.1.2" }))).toBe("windows · Edge 156");
    expect(personaLabel(p("x"))).toBe("Chrome");
    expect(tagCounts([p("a", { tags: ["shop", "DE"] }), p("b", { tags: ["Shop"] })])).toEqual([
      { tag: "shop", count: 2 },
      { tag: "DE", count: 1 },
    ]);
  });
});
