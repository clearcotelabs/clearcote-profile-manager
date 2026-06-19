import { describe, it, expect } from "vitest";
import { parseProxy, redactProxyString, needsRelay, proxyServerArg } from "../electron/proxy";

describe("parseProxy", () => {
  it("full string with credentials", () => {
    expect(parseProxy("http://user:pass@host:8080")).toMatchObject({
      scheme: "http", host: "host", port: 8080, username: "user", password: "pass",
    });
  });
  it("bare host:port defaults to http", () =>
    expect(parseProxy("host:3128")).toMatchObject({ scheme: "http", host: "host", port: 3128 }));
  it("socks5 with default port", () =>
    expect(parseProxy("socks5://h")).toMatchObject({ scheme: "socks5", host: "h", port: 1080 }));
  it("legacy {server,username,password} object", () =>
    expect(parseProxy({ server: "http://h:8080", username: "u", password: "p" })).toMatchObject({
      host: "h", port: 8080, username: "u", password: "p",
    }));
  it("URL-encoded credentials are decoded", () =>
    expect(parseProxy("http://u%40x:p%3As@h:8080")).toMatchObject({ username: "u@x", password: "p:s" }));
  it("dataimpulse-style username (underscores + dots)", () => {
    const p = parseProxy("http://e5112c5f__cr.us:secret@gw.example.com:10000")!;
    expect(p.username).toBe("e5112c5f__cr.us");
    expect(p.password).toBe("secret");
    expect(p.host).toBe("gw.example.com");
    expect(p.port).toBe(10000);
  });
  it("empty / nullish → null", () => {
    expect(parseProxy("")).toBeNull();
    expect(parseProxy(undefined)).toBeNull();
    expect(parseProxy(null)).toBeNull();
  });
});

describe("needsRelay — only authenticated http/https need the local relay", () => {
  it("authenticated http → relay", () => expect(needsRelay(parseProxy("http://u:p@h:8080")!)).toBe(true));
  it("authenticated https → relay", () => expect(needsRelay(parseProxy("https://u:p@h:8443")!)).toBe(true));
  it("credential-less http → no relay", () => expect(needsRelay(parseProxy("http://h:8080")!)).toBe(false));
  it("authenticated socks → no relay (native auth)", () =>
    expect(needsRelay(parseProxy("socks5://u:p@h:1080")!)).toBe(false));
});

describe("proxyServerArg — credential-free value for --proxy-server", () => {
  it("strips credentials", () => expect(proxyServerArg(parseProxy("http://u:p@h:8080")!)).toBe("http://h:8080"));
  it("keeps scheme + port", () => expect(proxyServerArg(parseProxy("socks5://h:1080")!)).toBe("socks5://h:1080"));
});

describe("redactProxyString", () => {
  it("removes the password, keeps user + host", () => {
    const r = redactProxyString("http://user:secret@host:8080");
    expect(r).not.toContain("secret");
    expect(r).toContain("user");
    expect(r).toContain("host:8080");
  });
  it("no-credential proxy is unchanged in substance", () =>
    expect(redactProxyString("http://host:8080")).toContain("host:8080"));
});
