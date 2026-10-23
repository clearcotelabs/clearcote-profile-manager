// Every proxy form people paste must either be read correctly or be refused out loud — never read
// as "no proxy" (which launched on the PC's own IP, CR 10-23) and never read wrongly.
import { describe, expect, it } from "vitest";
import net from "node:net";
import { normalizeProxy, parseProxy, proxyArgs, proxyProblem, redactProxyString } from "../electron/proxyargs";
import { geoCheck } from "../electron/geo";
import { checkProxy } from "../electron/proxycheck";
import { cloudSessionPlan } from "../electron/cloudbody";
import { profilesFromProxyList } from "../src/lib/bulkCreate";
import { proxyFromText } from "../src/lib/quickCreate";

type Want = { scheme: string; host: string; port: number; username?: string; password?: string; raw: string };

// [input, scheme, host, port, user, pass, canonical]
const READS: [string, string, string, number, string | undefined, string | undefined, string][] = [
  // URL forms
  ["http://u:p@h.example.com:8080", "http", "h.example.com", 8080, "u", "p", "http://u:p@h.example.com:8080"],
  ["https://u:p@h.example.com:8443", "https", "h.example.com", 8443, "u", "p", "https://u:p@h.example.com:8443"],
  ["socks5://u:p@h.example.com:1080", "socks5", "h.example.com", 1080, "u", "p", "socks5://u:p@h.example.com:1080"],
  ["socks4://h.example.com:1080", "socks4", "h.example.com", 1080, undefined, undefined, "socks4://h.example.com:1080"],
  ["SOCKS5://U:P@H.Example.com:1080", "socks5", "h.example.com", 1080, "U", "P", "socks5://U:P@h.example.com:1080"],
  ["http://u:p@h.example.com:8080/", "http", "h.example.com", 8080, "u", "p", "http://u:p@h.example.com:8080"],
  // scheme aliases
  ["socks5h://u:p@h.example.com:1080", "socks5", "h.example.com", 1080, "u", "p", "socks5://u:p@h.example.com:1080"],
  ["socks://u:p@h.example.com:1080", "socks5", "h.example.com", 1080, "u", "p", "socks5://u:p@h.example.com:1080"],
  ["socks4a://h.example.com:1080", "socks4", "h.example.com", 1080, undefined, undefined, "socks4://h.example.com:1080"],
  // no scheme → http
  ["u:p@1.2.3.4:3128", "http", "1.2.3.4", 3128, "u", "p", "http://u:p@1.2.3.4:3128"],
  ["1.2.3.4:3128", "http", "1.2.3.4", 3128, undefined, undefined, "http://1.2.3.4:3128"],
  // vendor colon forms, with and without a scheme (the report: socks5://host:port:user:pass)
  ["relay-eu.example.com:1080:plan-a-country-dk-sid-x:pw61", "http", "relay-eu.example.com", 1080, "plan-a-country-dk-sid-x", "pw61", "http://plan-a-country-dk-sid-x:pw61@relay-eu.example.com:1080"],
  ["socks5://relay-eu.example.com:1080:plan-a-country-dk-sid-x:pw61", "socks5", "relay-eu.example.com", 1080, "plan-a-country-dk-sid-x", "pw61", "socks5://plan-a-country-dk-sid-x:pw61@relay-eu.example.com:1080"],
  ["user:pw:1.2.3.4:8080", "http", "1.2.3.4", 8080, "user", "pw", "http://user:pw@1.2.3.4:8080"],
  ["socks5://user:pw:gate.example.net:7000", "socks5", "gate.example.net", 7000, "user", "pw", "socks5://user:pw@gate.example.net:7000"],
  ["1.2.3.4:8080@user:pw", "http", "1.2.3.4", 8080, "user", "pw", "http://user:pw@1.2.3.4:8080"],
  ["socks5://gate.example.net:7000@user:pw", "socks5", "gate.example.net", 7000, "user", "pw", "socks5://user:pw@gate.example.net:7000"],
  ["gate.example.net:7000:onlyuser", "http", "gate.example.net", 7000, "onlyuser", undefined, "http://onlyuser@gate.example.net:7000"],
  // space / tab separated (copied from a spreadsheet)
  ["1.2.3.4\t8080\tuser\tpw", "http", "1.2.3.4", 8080, "user", "pw", "http://user:pw@1.2.3.4:8080"],
  ["socks5://1.2.3.4 1080 user pw", "socks5", "1.2.3.4", 1080, "user", "pw", "socks5://user:pw@1.2.3.4:1080"],
  ["1.2.3.4 8080", "http", "1.2.3.4", 8080, undefined, undefined, "http://1.2.3.4:8080"],
  // passwords with : and @ survive, in every layout
  ["gate.example.net:10000:user-x:p@ss:w", "http", "gate.example.net", 10000, "user-x", "p@ss:w", "http://user-x:p%40ss%3Aw@gate.example.net:10000"],
  ["user-x:p@ss@gate.example.net:10000", "http", "gate.example.net", 10000, "user-x", "p@ss", "http://user-x:p%40ss@gate.example.net:10000"],
  ["http://u%40x:p%3As@h.example.com:8080", "http", "h.example.com", 8080, "u@x", "p:s", "http://u%40x:p%3As@h.example.com:8080"],
  ["user:pa:ss:gate.example.net:7000", "http", "gate.example.net", 7000, "user", "pa:ss", "http://user:pa%3Ass@gate.example.net:7000"],
  // an email-style username
  ["gate.example.net:7000:me@mail.example:pw", "http", "gate.example.net", 7000, "me@mail.example", "pw", "http://me%40mail.example:pw@gate.example.net:7000"],
  // a numeric password does not flip host:port:user:pass into user:pass:host:port
  ["1.2.3.4:8080:user:12345", "http", "1.2.3.4", 8080, "user", "12345", "http://user:12345@1.2.3.4:8080"],
  // …and a numeric password in user:pass:host:port is read as that layout
  ["user:12345:1.2.3.4:8080", "http", "1.2.3.4", 8080, "user", "12345", "http://user:12345@1.2.3.4:8080"],
  // IPv6
  ["socks5://u:p@[2001:db8::1]:1080", "socks5", "[2001:db8::1]", 1080, "u", "p", "socks5://u:p@[2001:db8::1]:1080"],
  ["[2001:db8::1]:1080:u:p", "http", "[2001:db8::1]", 1080, "u", "p", "http://u:p@[2001:db8::1]:1080"],
  // localhost and default ports
  ["localhost:8888", "http", "localhost", 8888, undefined, undefined, "http://localhost:8888"],
  ["socks5://h.example.com", "socks5", "h.example.com", 1080, undefined, undefined, "socks5://h.example.com:1080"],
  ["  http://h.example.com:3128  ", "http", "h.example.com", 3128, undefined, undefined, "http://h.example.com:3128"],
];

describe("parseProxy reads every form vendors hand out", () => {
  it.each(READS)("%j", (input, scheme, host, port, username, password, raw) => {
    const want: Want = { scheme, host, port, username, password, raw };
    expect(parseProxy(input)).toMatchObject(want);
  });

  it.each(READS)("the canonical form of %j reads back to the same proxy", (input) => {
    const a = parseProxy(input)!;
    const b = parseProxy(a.raw)!;
    expect({ ...b, schemeGiven: true, portGiven: true }).toEqual({ ...a, schemeGiven: true, portGiven: true });
    expect(normalizeProxy(a.raw)).toBe(a.raw);
  });

  it("says whether the scheme and the port were typed", () => {
    expect(parseProxy("h.example.com")).toMatchObject({ schemeGiven: false, portGiven: false, port: 80 });
    expect(parseProxy("socks5://h.example.com")).toMatchObject({ schemeGiven: true, portGiven: false });
    expect(parseProxy("h.example.com:1:u:p")).toMatchObject({ schemeGiven: false, portGiven: true });
  });

  it("the legacy object form keeps its separate credentials", () => {
    expect(parseProxy({ server: "socks5://h.example.com:1080", username: "u", password: "p:@" })).toMatchObject({
      scheme: "socks5", host: "h.example.com", port: 1080, username: "u", password: "p:@", raw: "socks5://u:p%3A%40@h.example.com:1080",
    });
  });

  it("the switches for the report's address carry the proxy, the login and the UDP relay", () => {
    const p = parseProxy("socks5://relay-eu.example.com:1080:plan-a:pw");
    expect(proxyArgs(p, { socks5Udp: true })).toEqual([
      "--proxy-server=socks5://relay-eu.example.com:1080",
      "--socks5-credentials=plan-a:pw",
      "--socks5-udp",
    ]);
    expect(proxyArgs(parseProxy("socks5://[2001:db8::1]:1080"))).toEqual(["--proxy-server=socks5://[2001:db8::1]:1080"]);
  });
});

const UNREADABLE = [
  "ftp://h.example.com:21",
  "h.example.com:99999",
  "h.example.com:0",
  "h.example.com:port:user:pw",
  "a:b:c",
  "not a proxy at all",
  "1.2.3.4 8080 user",
  "http://h.example.com:8080/path",
  "http://h.example.com:8080?x=1",
  "user:pw@",
  "://h.example.com:80",
  "h_.example!.com:80",
];

describe("an address that cannot be read is refused, never treated as no proxy", () => {
  it.each(UNREADABLE)("%j does not parse and has a problem sentence", (input) => {
    expect(parseProxy(input)).toBeNull();
    expect(proxyProblem(input)).toMatch(/cannot be read/);
  });

  it("empty is not a problem — it is no proxy", () => {
    for (const v of [undefined, null, "", "   "]) expect(proxyProblem(v)).toBeNull();
    expect(proxyProblem("socks5://u:p@h.example.com:1080")).toBeNull();
  });

  it("Resolve refuses without touching the network", async () => {
    const before = net.Socket.prototype.connect;
    let connects = 0;
    net.Socket.prototype.connect = function (this: net.Socket, ...a: unknown[]) {
      connects++;
      return (before as (...x: unknown[]) => net.Socket).apply(this, a);
    } as typeof before;
    try {
      const r = await geoCheck({ id: "x", name: "x", proxy: "relay.example.com:port:user:pw" } as never);
      expect(r).toMatchObject({ ok: false });
      expect(r.error).toMatch(/cannot be read/);
      expect(connects).toBe(0);
    } finally {
      net.Socket.prototype.connect = before;
    }
  });

  it("a scheme-less address that fails says to try socks5://", async () => {
    // A port nothing listens on: the exit lookup fails at once, as a SOCKS-only port hanging up does.
    const srv = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const bare = await geoCheck({ id: "x", name: "x", proxy: `127.0.0.1:${port}:u:p` } as never, 3000);
      expect(bare.error).toMatch(/start the address with socks5:\/\//);
      const typed = await geoCheck({ id: "x", name: "x", proxy: `http://u:p@127.0.0.1:${port}` } as never, 3000);
      expect(typed.ok).toBe(false);
      expect(typed.error).not.toMatch(/socks5:\/\//);
    } finally {
      srv.close();
    }
  });

  it("Check refuses with the same sentence", async () => {
    const r = await checkProxy({ id: "x", name: "x", proxy: "relay.example.com:port:user:pw" } as never);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/cannot be read/);
  });

  it("the cloud refuses instead of switching to the included IP", () => {
    const r = cloudSessionPlan({ id: "x", name: "x", fingerprint: "s", proxy: "relay.example.com:port:user:pw" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/cannot be read/);
      expect(r.field).toBe("proxy");
    }
    // …unless the profile chose the included IP itself, which never uses the proxy.
    const managed = cloudSessionPlan({ id: "x", name: "x", fingerprint: "s", proxy: "relay.example.com:port:user:pw", cloud: { exit: "managed" } } as never);
    expect(managed.ok).toBe(true);
  });

  it("export never leaks a password it could not locate", () => {
    expect(redactProxyString("socks5://relay.example.com:1080:user:secret")).toBe("socks5://user@relay.example.com:1080");
    expect(redactProxyString("relay.example.com:port:user:secret")).not.toContain("secret");
  });
});

describe("the list and clipboard paths use the same reader", () => {
  it("a mixed vendor list becomes one profile per proxy, scheme kept", () => {
    const r = profilesFromProxyList(
      [
        "socks5://relay.example.com:1080:a:1",
        "user:pw:1.2.3.4:8080",
        "1.2.3.4:8081@user:pw",
        "5.6.7.8\t3128\tu\tp",
        "socks5h://u:p@9.9.9.9:1080",
        "garbage line",
        "relay.example.com:1080:a:1",
      ].join("\n"),
      { namePattern: "P {n}", geoip: true },
    );
    expect(r.profiles.map((p) => p.proxy)).toEqual([
      "socks5://a:1@relay.example.com:1080",
      "http://user:pw@1.2.3.4:8080",
      "http://user:pw@1.2.3.4:8081",
      "http://u:p@5.6.7.8:3128",
      "socks5://u:p@9.9.9.9:1080",
      // same host/port/login as line 1 but http — a different proxy, so not a duplicate
      "http://a:1@relay.example.com:1080",
    ]);
    expect(r.invalid).toEqual([{ line: 6, text: "garbage line" }]);
  });

  it("the clipboard offer takes vendor forms but never a sentence or a bare word", () => {
    expect(proxyFromText("socks5://relay.example.com:1080:a:1")).toBe("socks5://a:1@relay.example.com:1080");
    expect(proxyFromText("1.2.3.4:8081@user:pw")).toBe("http://user:pw@1.2.3.4:8081");
    for (const v of ["hello world", "password123", "proxy:8080", "go to the store", "a\nb.example.com:80"]) {
      expect(proxyFromText(v)).toBeNull();
    }
  });
});
