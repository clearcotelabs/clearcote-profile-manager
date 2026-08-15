// applyGeoip is what the `geoip` toggle actually does at launch. Before this existed the flag was
// saved on the profile and shown as a chip, and NOTHING read it — so a profile with geoip on and no
// explicit location launched with no --fingerprint-location at all and the Geolocation API answered
// with the host's real position. These tests pin the behaviour the toggle promises, with the
// network stubbed so they are deterministic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

const geoCheck = vi.hoisted(() => vi.fn());
vi.mock("../electron/geo", () => ({ geoCheck }));

// electron/store.ts resolves its dirs from app.getPath("userData") at import time, so the module
// has to be stubbed before launcher is pulled in.
vi.mock("electron", () => ({
  app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-geoip-")) },
}));

// Imported after the mocks are registered so the launcher binds to the stubs.
const { applyGeoip } = await import("../electron/launcher");

const SUCCESS = {
  ok: true,
  ip: "23.147.168.31",
  country: "United States",
  countryCode: "US",
  timezone: "America/Chicago",
  lat: 39.1484,
  lon: -94.5686,
  acceptLanguage: "en-US,en",
};

const profile = (over: Partial<Profile> = {}): Profile =>
  ({
    id: "p", name: "p", fingerprint: "seed", createdAt: "", updatedAt: "",
    proxy: "socks5://u:p@gw.example.com:10000", geoip: true,
    ...over,
  }) as Profile;

beforeEach(() => {
  geoCheck.mockReset();
  geoCheck.mockResolvedValue(SUCCESS);
});
afterEach(() => vi.clearAllMocks());

describe("applyGeoip — when it runs at all", () => {
  it("does nothing when geoip is off", async () => {
    const p = profile({ geoip: false });
    const r = await applyGeoip(p);
    expect(r.profile).toBe(p);
    expect(geoCheck).not.toHaveBeenCalled();
  });

  it("does nothing without a proxy — there is no exit region to match", async () => {
    const p = profile({ proxy: undefined });
    const r = await applyGeoip(p);
    expect(r.profile).toBe(p);
    expect(geoCheck).not.toHaveBeenCalled();
  });

  it("skips the network round-trip when every field is already set", async () => {
    const p = profile({
      timezone: "Europe/Berlin", acceptLanguage: "de-DE,de",
      location: "52.5,13.4", webrtcIp: "1.2.3.4",
    });
    const r = await applyGeoip(p);
    expect(r.profile).toBe(p);
    expect(geoCheck).not.toHaveBeenCalled();
  });
});

describe("applyGeoip — filling the gaps", () => {
  it("fills all four fields from the proxy's exit region", async () => {
    const { profile: out, warning } = await applyGeoip(profile());
    expect(warning).toBeUndefined();
    expect(out.timezone).toBe("America/Chicago");
    expect(out.acceptLanguage).toBe("en-US,en");
    expect(out.location).toBe("39.1484,-94.5686");
    expect(out.webrtcIp).toBe("23.147.168.31");
  });

  it("sets location as 'lat,lon' — the shape --fingerprint-location parses", async () => {
    const { profile: out } = await applyGeoip(profile());
    expect(out.location).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  });

  it("an explicit value always wins over the resolved one", async () => {
    const { profile: out } = await applyGeoip(
      profile({ timezone: "Asia/Tokyo", location: "35.6,139.6" }),
    );
    expect(out.timezone).toBe("Asia/Tokyo");
    expect(out.location).toBe("35.6,139.6");
    // ...while the unset ones are still filled.
    expect(out.acceptLanguage).toBe("en-US,en");
    expect(out.webrtcIp).toBe("23.147.168.31");
  });

  it("treats an empty string as unset, not as a deliberate choice", async () => {
    const { profile: out } = await applyGeoip(profile({ timezone: "", location: "" }));
    expect(out.timezone).toBe("America/Chicago");
    expect(out.location).toBe("39.1484,-94.5686");
  });

  it("does not mutate the caller's profile", async () => {
    const p = profile();
    await applyGeoip(p);
    expect(p.timezone).toBeUndefined();
    expect(p.location).toBeUndefined();
  });

  it("omits location when the service returned no coordinates", async () => {
    geoCheck.mockResolvedValue({ ...SUCCESS, lat: undefined, lon: undefined });
    const { profile: out } = await applyGeoip(profile());
    expect(out.location).toBeUndefined();
    expect(out.timezone).toBe("America/Chicago"); // the rest still applies
  });
});

describe("applyGeoip — failure is not fatal", () => {
  it("returns the profile unchanged with a warning naming the cause", async () => {
    geoCheck.mockResolvedValue({ ok: false, error: "SOCKS5 authentication failed" });
    const { profile: out, warning } = await applyGeoip(profile());
    expect(out.location).toBeUndefined();
    expect(warning).toContain("SOCKS5 authentication failed");
    expect(warning).toMatch(/geoip/i);
  });
});

// ---------------------------------------------------------------------------
// geoip is now ON by default, and switched on automatically when a proxy is added.
//
// The off-by-default version is what a customer actually hit: the profile looked configured, no
// --fingerprint-location was emitted, and the Geolocation API kept reporting the real position.
// Both halves of the fix are pinned here — the default itself, and that applyGeoip still refuses to
// override anything the user chose, because a default that silently overwrites is worse than the
// bug it replaces.
// ---------------------------------------------------------------------------
describe("geoip default", () => {
  it("a new profile has geoip on", async () => {
    // Mirrors newProfile() in app/page.tsx. Kept as an explicit assertion because the default is the
    // whole fix: flipping it back to false would restore the reported bug with every test still green.
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
    const line = page.split("\n").find((l) => l.includes("function newProfile") || l.includes("geoip:"));
    expect(page).toMatch(/geoip:\s*true/);
    expect(line).toBeDefined();
  });

  it("still fills only what the user left blank", async () => {
    // The default being ON makes this guarantee load-bearing: geoip now runs for nearly every
    // proxied profile, so if it overrode explicit values it would quietly rewrite people's personas.
    geoCheck.mockResolvedValue(SUCCESS);
    const { profile: out } = await applyGeoip(
      profile({ geoip: true, timezone: "Europe/Berlin", location: "52.5,13.4" }),
    );
    expect(out.timezone).toBe("Europe/Berlin");
    expect(out.location).toBe("52.5,13.4");
    expect(out.acceptLanguage).toBe("en-US,en");
    expect(out.webrtcIp).toBe("23.147.168.31");
  });

  it("a user who turns geoip off is still respected at launch", async () => {
    geoCheck.mockResolvedValue(SUCCESS);
    const p = profile({ geoip: false });
    const r = await applyGeoip(p);
    expect(r.profile).toBe(p);
    expect(geoCheck).not.toHaveBeenCalled();
  });
});
