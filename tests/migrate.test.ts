// electron/migrate.ts + electron/cookiejar.ts — cookie files in the usual formats, other browsers' exports
// read by field name, and the pending cookie file a launch picks up. Real files in a temp dir.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-migrate-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

type M = typeof import("../electron/migrate");
type J = typeof import("../electron/cookiejar");
type H = typeof import("../electron/handlers");
let m: M;
let jar: J;
let h: H;

beforeAll(async () => {
  m = await import("../electron/migrate");
  jar = await import("../electron/cookiejar");
  h = await import("../electron/handlers");
});
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const NOW = 1_800_000_000; // seconds
const FUTURE = NOW + 86400 * 30;

describe("parseCookies", () => {
  it("reads Netscape cookies.txt, with #HttpOnly_ lines and subdomain flags", () => {
    const txt = [
      "# Netscape HTTP Cookie File",
      `.example.com\tTRUE\t/\tTRUE\t${FUTURE}\tsid\tabc`,
      `#HttpOnly_shop.example.com\tFALSE\t/cart\tFALSE\t0\tcart\tx\ty`,
      `old.example.com\tFALSE\t/\tFALSE\t${NOW - 10}\tgone\t1`,
      "broken line",
    ].join("\n");
    const r = m.parseCookies(txt, NOW);
    expect(r.expired).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.cookies).toEqual([
      { name: "sid", value: "abc", domain: ".example.com", path: "/", secure: true, httpOnly: false, expires: FUTURE },
      // host-only → url, tab inside the value kept, expiry 0 = session cookie
      { name: "cart", value: "x\ty", url: "http://shop.example.com/cart", path: "/cart", secure: false, httpOnly: true },
    ]);
  });

  it("reads the extensions' JSON (EditThisCookie / Cookie-Editor) and CDP-style JSON", () => {
    const json = JSON.stringify([
      { domain: ".x.com", hostOnly: false, name: "a", value: "1", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: FUTURE + 0.5 },
      { domain: "x.com", hostOnly: true, name: "b", value: "2", sameSite: "lax", session: true },
      { domain: "y.com", name: "c", value: "3", sameSite: "None", secure: false, expires: FUTURE * 1000 }, // ms
      { name: "no-domain", value: "4" },
    ]);
    const r = m.parseCookies(json, NOW);
    expect(r.skipped).toBe(1);
    expect(r.cookies[0]).toMatchObject({ domain: ".x.com", sameSite: "None", secure: true, httpOnly: true, expires: FUTURE });
    expect(r.cookies[1]).toEqual({ name: "b", value: "2", url: "http://x.com/", path: "/", secure: false, httpOnly: false, sameSite: "Lax" });
    // SameSite=None without Secure would be refused: dropped, so the browser's default applies.
    expect(r.cookies[2].sameSite).toBeUndefined();
    expect(r.cookies[2].expires).toBe(FUTURE);
  });

  it("finds the list inside an object and inside a JSON string", () => {
    const inner = [{ domain: ".z.com", name: "k", value: "v" }];
    expect(m.parseCookies({ cookies: inner }, NOW).cookies).toHaveLength(1);
    expect(m.parseCookies(JSON.stringify({ data: inner }), NOW).cookies).toHaveLength(1);
  });

  it("__Host- cookies are host-only and secure", () => {
    const r = m.parseCookies([{ domain: ".a.com", name: "__Host-s", value: "1" }], NOW);
    expect(r.cookies[0]).toMatchObject({ url: "https://a.com/", secure: true });
    expect(r.cookies[0].domain).toBeUndefined();
  });

  it("mergeCookies: the later cookie of the same name/domain/path wins", () => {
    const a = m.parseCookies([{ domain: ".a.com", name: "s", value: "old" }], NOW).cookies;
    const b = m.parseCookies([{ domain: ".a.com", name: "s", value: "new" }, { domain: ".a.com", name: "t", value: "1" }], NOW).cookies;
    expect(m.mergeCookies(a, b).map((c) => `${c.name}=${c.value}`)).toEqual(["s=new", "t=1"]);
  });
});

describe("parseMigration", () => {
  it("reads a GoLogin-style JSON list: nested proxy object, navigator UA, cookies", () => {
    const data = {
      profiles: [
        {
          name: "Shop 1",
          notes: "main account",
          tags: ["ebay", "uk"],
          os: "mac",
          navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
          proxy: { mode: "socks5", host: "1.2.3.4", port: 1080, username: "u", password: "p:w" },
          cookies: [{ domain: ".ebay.co.uk", name: "s", value: "1", expirationDate: FUTURE }],
        },
        { name: "Bare", proxy: { mode: "none" } },
      ],
    };
    const r = m.parseMigration(JSON.stringify(data), "gologin.json", NOW);
    expect(r.profiles).toHaveLength(2);
    expect(r.profiles[0]).toMatchObject({ name: "Shop 1", notes: "main account", tags: ["ebay", "uk"], platform: "macos" });
    expect(r.profiles[0].proxy).toMatch(/^socks5:\/\/u:p(%3A|:)w@1\.2\.3\.4:1080$/);
    expect(r.profiles[0].cookies).toHaveLength(1);
    expect(r.profiles[1].proxy).toBeUndefined();
    expect(r.cookies).toBe(1);
  });

  it("reads an AdsPower/Dolphin-style CSV with proxy columns and a cookie JSON cell", () => {
    const cookie = JSON.stringify([{ domain: ".fb.com", name: "c_user", value: "9" }]).replace(/"/g, '""');
    const csv = [
      "Name;Remark;Group;Proxy Type;Proxy Host;Proxy Port;Proxy User;Proxy Password;User Agent;Cookie",
      `acc-1;first;Team A;http;5.6.7.8;8080;bob;secret;\"Mozilla/5.0 (Windows NT 10.0; Win64; x64)\";"${cookie}"`,
      `acc-2;;Team A;;;;;;Mozilla/5.0 (X11; Linux x86_64);`,
      ";;;;;;;;;",
    ].join("\r\n");
    const r = m.parseMigration(csv, "adspower.csv", NOW);
    expect(r.profiles.map((p) => p.name)).toEqual(["acc-1", "acc-2"]);
    expect(r.profiles[0]).toMatchObject({ notes: "first", group: "Team A", platform: "windows" });
    expect(r.profiles[0].proxy).toBe("http://bob:secret@5.6.7.8:8080");
    expect(r.profiles[0].cookies[0]).toMatchObject({ name: "c_user", domain: ".fb.com" });
    expect(r.profiles[1]).toMatchObject({ platform: "linux", cookies: [] });
    expect(r.skipped).toBe(0); // a blank row is not a profile left out
  });

  it("a proxy string in a column goes through the same reader as the editor", () => {
    const r = m.parseMigration("name,proxy\nx,9.9.9.9:3128:user:pw\ny,not a proxy at all", "", NOW);
    expect(r.profiles[0].proxy).toBe("http://user:pw@9.9.9.9:3128");
    expect(r.profiles[1].proxy).toBeUndefined();
    expect(r.warnings.join(" ")).toMatch(/“y”: the proxy/);
  });

  it("a bare cookie export becomes one profile named after the file", () => {
    const r = m.parseMigration(JSON.stringify([{ domain: ".a.com", name: "s", value: "1" }]), "C:\\dl\\my-account.json", NOW);
    expect(r.profiles).toEqual([expect.objectContaining({ name: "my-account" })]);
    expect(r.cookies).toBe(1);
    const t = m.parseMigration(`.a.com\tTRUE\t/\tFALSE\t0\ts\t1`, "acc.txt", NOW);
    expect(t.profiles[0]).toMatchObject({ name: "acc", cookies: [expect.objectContaining({ name: "s" })] });
  });

  it("refuses Excel files and files with nothing in them, saying what to do", () => {
    expect(() => m.parseMigration("PK\x03\x04garbage", "x.xlsx")).toThrow(/save it as CSV/);
    expect(() => m.parseMigration("   ", "x.csv")).toThrow(/empty/);
    expect(() => m.parseMigration("[]", "x.json")).toThrow(/No profiles/);
  });
});

describe("migrateImport + importCookies (handlers)", () => {
  it("creates profiles with a fresh seed and parks their cookies; cookies merge into a profile", () => {
    const csv = `name,tags,proxy,cookies\nAlpha,"a,b",1.1.1.1:80,"[{""domain"":"".a.com"",""name"":""s"",""value"":""1""}]"`;
    const r = h.migrateImport(csv, "list.csv") as { ok: boolean; count: number; cookies: number };
    expect(r).toMatchObject({ ok: true, count: 1, cookies: 1 });
    const files = fs.readdirSync(path.join(ROOT, "profiles")).filter((f) => f.startsWith("alpha-") && f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, "profiles", files[0]), "utf8"));
    expect(p).toMatchObject({ name: "Alpha", tags: ["a", "b"], proxy: "http://1.1.1.1:80", geoip: true, widevine: true });
    expect(p.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(jar.readPending(p.id)).toHaveLength(1);

    const more = h.importCookies(p.id, `.a.com\tTRUE\t/\tFALSE\t0\ts\t2\n.b.com\tTRUE\t/\tFALSE\t0\tt\t3`);
    expect(more).toMatchObject({ ok: true, count: 2, pending: 2 });
    expect(jar.readPending(p.id).find((c) => c.name === "s")?.value).toBe("2");

    expect(h.importCookies("nope", "x")).toMatchObject({ ok: false });
    expect(h.importCookies(p.id, "hello")).toMatchObject({ ok: false, error: expect.stringMatching(/No cookies/) });
    jar.clearPending(p.id);
    expect(jar.readPending(p.id)).toEqual([]);
  });

  it("injectCookies sets one per call and counts refusals; a closed pipe stops it", async () => {
    const cookies = m.parseCookies([{ domain: ".a.com", name: "1", value: "" }, { domain: ".a.com", name: "bad", value: "" }, { domain: ".a.com", name: "3", value: "" }], NOW).cookies;
    const sent: unknown[] = [];
    const cdp = {
      send: async (method: string, params: { cookies: { name: string }[] }) => {
        sent.push([method, params.cookies.length]);
        if (params.cookies[0].name === "bad") throw new Error("Invalid cookie fields");
        return {};
      },
    };
    expect(await jar.injectCookies(cdp as never, cookies)).toEqual({ set: 2, refused: 1 });
    expect(sent).toEqual([["Storage.setCookies", 1], ["Storage.setCookies", 1], ["Storage.setCookies", 1]]);
    const closed = { send: async () => Promise.reject(new Error("the browser closed the DevTools pipe")) };
    await expect(jar.injectCookies(closed as never, cookies)).rejects.toThrow(/closed/);
  });
});
