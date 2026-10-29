// r54: a launch with Relay UDP on whose proxy REFUSES the UDP association (pinUdpSession's verdict) runs
// with Relay UDP off, and says so. A relay through such a proxy closes every UDP socket at once (WebRTC
// error + no public address, HTTP/3 never starts); with it off the browser behaves as with the toggle off.

import { describe, it, expect, vi, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

// electron/store.ts resolves its dirs from app.getPath("userData") at import time (see launcher.test.ts).
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-relayudp-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
let relayUdpAfterPin: typeof import("../electron/launcher").relayUdpAfterPin;
beforeAll(async () => { ({ relayUdpAfterPin } = await import("../electron/launcher")); });

const prof = (socks5Udp: boolean) => ({ id: "p1", name: "t", proxy: "socks5://203.0.113.5:1080", socks5Udp }) as unknown as Profile;

describe("relayUdpAfterPin", () => {
  it("turns Relay UDP off for this launch when the proxy refused UDP, with a warning", () => {
    const r = relayUdpAfterPin(prof(true), { udp: "refused", detail: "The proxy said: not allowed by its rules." });
    expect(r.profile.socks5Udp).toBe(false);
    expect(r.warning).toContain("Relay UDP is off for this launch: the proxy refused UDP (The proxy said: not allowed by its rules)");
  });

  it("leaves the profile it was given unchanged", () => {
    const p = prof(true);
    relayUdpAfterPin(p, { udp: "refused" });
    expect(p.socks5Udp).toBe(true);
  });

  it.each(["works", "no-reply", "error", "not-socks"] as const)("keeps Relay UDP on when the verdict is %s", (udp) => {
    const r = relayUdpAfterPin(prof(true), { udp });
    expect(r.profile.socks5Udp).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("does nothing with Relay UDP off or without a verdict", () => {
    expect(relayUdpAfterPin(prof(false), { udp: "refused" })).toEqual({ profile: prof(false) });
    expect(relayUdpAfterPin(prof(true), undefined).profile.socks5Udp).toBe(true);
  });
});
