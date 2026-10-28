// Switches the SDK sends that the profile manager now sends too (SDK 0.51 parity): Web Bluetooth by
// claimed platform, no UDP around a proxy, and one --enable/--disable-features each.

import { describe, expect, it } from "vitest";
import { fingerprintArgs, mergeFeatureFlags, proxyEgressArgs } from "../electron/fpargs";
import { profileToArgs, type Profile } from "../src/types/profile";

describe("Web Bluetooth follows the claimed platform", () => {
  it.each([
    ["windows", "--enable-features=WebBluetooth"],
    ["macos", "--enable-features=WebBluetooth"],
    ["android", "--enable-features=WebBluetooth"],
    ["linux", "--disable-features=WebBluetooth"],
  ])("%s -> %s", (platform, flag) => {
    expect(fingerprintArgs({ fingerprint: "s", platform } as never)).toContain(flag);
  });
  it("defaults to the host platform when the profile claims none", () => {
    expect(fingerprintArgs({ fingerprint: "s" }, { hostPlatform: "linux" })).toContain("--disable-features=WebBluetooth");
    expect(fingerprintArgs({ fingerprint: "s" }, { hostPlatform: "windows" })).toContain("--enable-features=WebBluetooth");
  });
});

describe("proxyEgressArgs", () => {
  it("adds nothing without a proxy", () => {
    expect(proxyEgressArgs(false)).toEqual([]);
  });
  it("turns QUIC off and denies non-proxied UDP behind a proxy", () => {
    expect(proxyEgressArgs(true)).toEqual(["--disable-quic", "--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
  });
  it("leaves the WebRTC policy to the user when extraArgs sets one, and never repeats a switch", () => {
    expect(proxyEgressArgs(true, ["--webrtc-ip-handling-policy=default"])).toEqual(["--disable-quic"]);
    expect(proxyEgressArgs(true, ["--disable-quic"])).toEqual(["--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
  });
  it("keeps QUIC on when the engine carries it through the SOCKS5 UDP relay (PRO r54+)", () => {
    expect(proxyEgressArgs(true, [], true)).toEqual(["--webrtc-ip-handling-policy=disable_non_proxied_udp"]);
    expect(proxyEgressArgs(false, [], true)).toEqual([]);
  });
});

describe("mergeFeatureFlags", () => {
  it("collapses each list into one switch where it first appeared, de-duplicated", () => {
    expect(
      mergeFeatureFlags([
        "--a",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--enable-features=WebBluetooth",
        "--disable-features=Foo,WebRtcHideLocalIpsWithMdns",
        "https://example.com/",
      ]),
    ).toEqual([
      "--a",
      "--disable-features=WebRtcHideLocalIpsWithMdns,Foo",
      "--enable-features=WebBluetooth",
      "https://example.com/",
    ]);
  });
  it("drops an empty list rather than emitting a bare switch", () => {
    expect(mergeFeatureFlags(["--disable-features=", "--x"])).toEqual(["--x"]);
  });
});

describe("the command-line preview", () => {
  const base = { id: "p", name: "p", fingerprint: "s", createdAt: "", updatedAt: "" } as unknown as Profile;
  it("keeps a user's own --disable-features alongside the defaults, and the start URL last", () => {
    const a = profileToArgs({
      ...base,
      platform: "linux",
      webrtcMdns: "off",
      proxy: "socks5://h:1080",
      extraArgs: ["--disable-features=Translate"],
      startUrl: "https://example.com/",
    } as Profile);
    expect(a.filter((x) => x.startsWith("--disable-features="))).toEqual([
      "--disable-features=WebRtcHideLocalIpsWithMdns,WebBluetooth,Translate",
    ]);
    expect(a).toContain("--disable-quic");
    expect(a).toContain("--webrtc-ip-handling-policy=disable_non_proxied_udp");
    expect(a[a.length - 1]).toBe("https://example.com/");
  });
});
