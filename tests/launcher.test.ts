// electron/launcher.ts buildArgs — the command line that ACTUALLY gets spawned.
//
// This path had no tests: the suite covered src/types/profile.ts's profileToArgs, which is only the
// UI preview. The two were hand-maintained copies and had drifted (the launcher never emitted
// --lang, the native metadata overrides, or --no-sandbox for the canvas bridge). Both now delegate
// to electron/fpargs.ts; these tests pin the parts that are genuinely launcher-only — reading and
// gzip-encoding the captured profile, the resolved user-data-dir, and extraArgs ordering.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// electron/store.ts resolves its dirs from app.getPath("userData") at import time, so the module
// has to be stubbed before launcher is pulled in.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-launcher-"));
vi.mock("electron", () => ({
  app: { getPath: () => ROOT },
}));

let buildArgs: typeof import("../electron/launcher").buildArgs;
const FINGERPRINTS = path.join(ROOT, "fingerprints");

// A minimal but realistic capture: the fields summarizeFingerprint looks for, plus the
// navigator.languages the launcher should recover for Accept-Language.
const CAPTURE = {
  meta: { id: "donor-01" },
  screen: { width: 2560, height: 1440 },
  hardware_concurrency: 24,
  device_memory: 32,
  navigator: { languages: ["de-DE", "de", "en-US"] },
  webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: "ANGLE (NVIDIA RTX 4070)" } } },
};

beforeAll(async () => {
  fs.mkdirSync(FINGERPRINTS, { recursive: true });
  fs.writeFileSync(path.join(FINGERPRINTS, "donor.json"), JSON.stringify(CAPTURE), "utf8");
  ({ buildArgs } = await import("../electron/launcher"));
});
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const base = { id: "p1", name: "p1", fingerprint: "seed-1", createdAt: "", updatedAt: "" };
const build = (over: Record<string, unknown> = {}, udd = "C:/udd") =>
  buildArgs({ ...base, ...over } as never, udd);

describe("buildArgs — launcher-only concerns", () => {
  it("appends the resolved user-data-dir", () =>
    expect(build({}, "C:/profiles/p1/userdata")).toContain("--user-data-dir=C:/profiles/p1/userdata"));

  it("appends extraArgs verbatim, AFTER the generated switches so the user's value wins", () => {
    const a = build({ extraArgs: ["--foo", "--window-size=800,600"] });
    expect(a.slice(-2)).toEqual(["--foo", "--window-size=800,600"]);
  });

  it("does NOT emit --proxy-server (launch() adds it, possibly via the auth relay)", () =>
    expect(build({ proxy: "http://u:p@h:8080" }).some((s) => s.startsWith("--proxy-server"))).toBe(false));

  it("carries the SDK parity switches the launcher previously omitted", () => {
    const a = build({ deviceMemory: 16, maxTouchPoints: 0, webrtcMdns: "off" });
    expect(a).toEqual(
      expect.arrayContaining([
        "--lang=en-US",
        "--accept-lang=en-US,en",
        "--timezone=America/New_York",
        "--fingerprint-brand=chrome",
        "--fingerprint-device-memory=16",
        "--fingerprint-max-touch-points=0",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
      ]),
    );
  });

  it("enabling the canvas bridge adds --no-sandbox (the socket opens from the renderer)", () =>
    expect(build({ canvasBridgeUrl: "ws://h:9000" })).toContain("--no-sandbox"));
});

describe("buildArgs — captured fingerprint profile", () => {
  it("gzip+base64-encodes the file, and the engine can round-trip it back", () => {
    const sw = build({ fingerprintProfile: "donor.json" }).find((s) => s.startsWith("--fingerprint-profile="));
    expect(sw).toBeTruthy();
    const b64 = sw!.slice("--fingerprint-profile=".length);
    // Exactly what the engine does: base64-decode, gunzip, JSON.parse.
    const back = JSON.parse(zlib.gunzipSync(Buffer.from(b64, "base64")).toString("utf8"));
    expect(back).toEqual(CAPTURE);
  });

  it("compresses enough to stay inside Chromium's command-line length limit", () => {
    const big = { ...CAPTURE, fonts: Array.from({ length: 900 }, (_, i) => `Font Family ${i}`) };
    fs.writeFileSync(path.join(FINGERPRINTS, "big.json"), JSON.stringify(big), "utf8");
    const sw = build({ fingerprintProfile: "big.json" }).find((s) => s.startsWith("--fingerprint-profile="))!;
    const raw = fs.statSync(path.join(FINGERPRINTS, "big.json")).size;
    expect(sw.length).toBeLessThan(raw / 3); // gzip ~6x on this shape; a 3x floor is a safe guard
    expect(sw.length).toBeLessThan(32000); // well under the practical Windows command-line ceiling
  });

  it("resolves a bare filename against the shared fingerprints dir, and an absolute path directly", () => {
    const abs = path.join(ROOT, "elsewhere.json");
    fs.writeFileSync(abs, JSON.stringify(CAPTURE), "utf8");
    for (const ref of ["donor.json", abs]) {
      expect(build({ fingerprintProfile: ref }).some((s) => s.startsWith("--fingerprint-profile="))).toBe(true);
    }
  });

  it("a missing profile file degrades to the seed instead of failing the launch", () => {
    const a = build({ fingerprintProfile: "does-not-exist.json" });
    expect(a.some((s) => s.startsWith("--fingerprint-profile="))).toBe(false);
    expect(a).toContain("--fingerprint=seed-1"); // still launches, just without the capture
  });

  it("recovers the donor's navigator.languages for Accept-Language + --lang", () => {
    const a = build({ fingerprintProfile: "donor.json" });
    expect(a).toContain("--accept-lang=de-DE,de,en-US");
    expect(a).toContain("--lang=de-DE");
    // …and the derived timezone follows that locale rather than the host's.
    expect(a).toContain("--timezone=Europe/Berlin");
  });

  it("an explicit acceptLanguage still beats the donor's", () =>
    expect(build({ fingerprintProfile: "donor.json", acceptLanguage: "ja-JP,ja" })).toContain(
      "--accept-lang=ja-JP,ja",
    ));

  it("an unreadable/garbage profile doesn't break language resolution", () => {
    fs.writeFileSync(path.join(FINGERPRINTS, "junk.json"), "not json at all", "utf8");
    expect(build({ fingerprintProfile: "junk.json" })).toContain("--accept-lang=en-US,en");
  });
});

describe("buildArgs — lightStealth on the real launch path", () => {
  it("emits NO --fingerprint, which is the entire point of the preset", () => {
    const a = build({ lightStealth: true });
    expect(a.some((s) => s.startsWith("--fingerprint="))).toBe(false);
    // …but the user-data-dir and the native overrides are still there.
    expect(a).toContain("--user-data-dir=C:/udd");
    expect(a.some((s) => s.startsWith("--fingerprint-device-memory="))).toBe(true);
  });
});
