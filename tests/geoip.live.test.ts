// A resolved WebRTC IP follows a REAL proxy at launch. Opt-in like geo.live.test.ts: set
// CLEARCOTE_TEST_PROXY to a proxy string and run the suite; skipped otherwise, so no credentials
// are committed and CI never depends on a vendor being up.
//
//   CLEARCOTE_TEST_PROXY="socks5://user:pass@host:1080" npx vitest run tests/geoip.live.test.ts
//
// CR-LYJSFW: "Resolve from proxy" had stored the exit of that moment as the WebRTC IP; the vendor's
// sticky session moved on, and the browser kept naming the snapshot. The unit tests prove the rule
// with a stubbed lookup; this proves the whole path — a real lookup through the proxy, the saved
// profile updated — against the shape of proxy that failed in the field (authenticated SOCKS5).

import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

const PROXY = process.env.CLEARCOTE_TEST_PROXY;
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-geoip-live-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const { applyGeoip } = await import("../electron/launcher");
const { saveProfile, getProfile } = await import("../electron/profiles");

describe.skipIf(!PROXY)("a resolved WebRTC IP follows a live proxy", () => {
  it("replaces the stale snapshot with the proxy's current exit and saves it", async () => {
    // 1.2.3.4 stands in for the exit an earlier Resolve found; lastGeo says the app resolved it.
    const stale = "1.2.3.4";
    const p = saveProfile({
      id: "live-follow", name: "live", fingerprint: "seed", createdAt: "", updatedAt: "",
      proxy: PROXY, geoip: true,
      timezone: "Europe/Copenhagen", acceptLanguage: "da-DK,da,en", location: "55.6,12.5",
      webrtcIp: stale,
      lastGeo: { ip: stale, at: new Date().toISOString(), proxy: "x" },
    } as Profile);

    const r = await applyGeoip(p);
    expect(r.warning).toBeUndefined();
    expect(r.profile.webrtcIp).toMatch(/^\d+\.\d+\.\d+\.\d+$|:/);
    expect(r.profile.webrtcIp).not.toBe(stale);
    expect(r.refreshedWebrtcIp).toBe(r.profile.webrtcIp);
    // The user's region is untouched.
    expect(r.profile.location).toBe("55.6,12.5");

    const onDisk = getProfile("live-follow")!;
    expect(onDisk.webrtcIp).toBe(r.profile.webrtcIp);
    expect(onDisk.lastGeo?.ip).toBe(r.profile.webrtcIp);

    // A typed address through the same proxy is left alone, and costs no lookup.
    const typed = saveProfile({ ...onDisk, id: "live-typed", webrtcIp: "203.0.113.9" });
    const r2 = await applyGeoip(typed);
    expect(r2.profile.webrtcIp).toBe("203.0.113.9");
  }, 60000);
});
