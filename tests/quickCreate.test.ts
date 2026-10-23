import { describe, expect, it } from "vitest";
import {
  protectedSwitches,
  proxyFromText,
  proxyLabel,
  screenSource,
  withHostScreen,
  withoutScreen,
} from "../src/lib/quickCreate";
import type { Profile } from "../src/types/profile";

const base = { id: "", name: "x", fingerprint: "abc" } as Profile;
const host = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1032 };

describe("Use this display", () => {
  it("fills all four screen fields from the display, taskbar included", () => {
    const p = withHostScreen(base, host);
    expect([p.screenWidth, p.screenHeight, p.availWidth, p.availHeight]).toEqual([1920, 1080, 1920, 1032]);
    expect(screenSource(p, host)).toBe("host");
  });

  it("tells empty, this display and anything else apart", () => {
    expect(screenSource(base, host)).toBe("empty");
    expect(screenSource({ ...withHostScreen(base, host), availHeight: 1023 }, host)).toBe("other");
    expect(screenSource({ ...base, screenWidth: 1920 }, undefined)).toBe("other");
  });

  it("Clear removes all four and nothing else", () => {
    const p = withoutScreen({ ...withHostScreen(base, host), proxy: "http://h.example:1" } as Profile);
    expect(screenSource(p, host)).toBe("empty");
    expect(p.proxy).toBe("http://h.example:1");
    expect("screenWidth" in p).toBe(false);
  });
});

describe("proxy from the clipboard", () => {
  it.each([
    ["gw.example.io:7777:user-x:p@ss", "http://user-x:p%40ss@gw.example.io:7777"],
    ["http://u:p@1.2.3.4:8080", "http://u:p@1.2.3.4:8080"],
    ["socks5://u:p@proxy.example.com:1080", "socks5://u:p@proxy.example.com:1080"],
    ["  10.0.0.1:3128 \n", "http://10.0.0.1:3128"],
    ["socks5://relay-eu.example.com:1080:plan-a-country-dk:pw", "socks5://plan-a-country-dk:pw@relay-eu.example.com:1080"],
    ["user:pw:1.2.3.4:8080", "http://user:pw@1.2.3.4:8080"],
  ])("accepts %j", (text, want) => {
    expect(proxyFromText(text)).toBe(want);
  });

  it.each([
    "",
    "hello",
    "password123",
    "some sentence with words",
    "https://example.com/page",
    "example.com",
    "ftp://h.example:21",
    "localhostish:80:a",
  ])("ignores %j", (text) => {
    expect(proxyFromText(text)).toBeNull();
  });

  it("labels a proxy without its login", () => {
    expect(proxyLabel("http://user:secret@gw.example.io:7777")).toBe("gw.example.io:7777");
  });
});

describe("protected switches", () => {
  it("lists nothing without a proxy", () => {
    expect(protectedSwitches(base)).toEqual([]);
  });

  it("explains both switches a proxy adds", () => {
    const list = protectedSwitches({ ...base, proxy: "http://h.example:8080" });
    expect(list.map((s) => s.arg)).toEqual(["--disable-quic", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
    expect(list.every((s) => s.why.length > 20)).toBe(true);
  });

  it("drops the WebRTC policy when the user set their own", () => {
    const list = protectedSwitches({
      ...base,
      proxy: "http://h.example:8080",
      extraArgs: ["--webrtc-ip-handling-policy=default_public_interface_only"],
    });
    expect(list.map((s) => s.arg)).toEqual(["--disable-quic"]);
  });
});
