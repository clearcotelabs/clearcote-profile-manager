// src/lib/launchError.ts — every launch-failure shape the app actually produces, mapped to a title,
// a plain explanation and the one action that fixes it. The inputs are the real strings the
// launcher, the download client and the licence client build (see electron/launcher.ts,
// electron/proBinary.ts, electron/license.ts, electron/catalog.ts).

import { describe, it, expect } from "vitest";
import {
  actionLabel,
  describeLaunchError,
  describeLaunchWarnings,
  extractServerBody,
} from "../src/lib/launchError";

// Verbatim from the bug report screenshot.
const SCREENSHOT =
  'Could not obtain the browser: PRO download not authorized (HTTP 403): {"error":"The free tier always uses the latest build. Choosing a specific version or the preview channel is a Pro feature.","code":"FREE_LATEST_ONLY"}';

describe("extractServerBody", () => {
  it("pulls error + code out of an embedded JSON body, and keeps the prefix", () => {
    const b = extractServerBody('PRO download not authorized (HTTP 401): {"error":"Invalid license key.","code":"INVALID_LICENSE"}');
    expect(b).toEqual({
      error: "Invalid license key.",
      code: "INVALID_LICENSE",
      rest: "PRO download not authorized (HTTP 401)",
    });
  });

  it("survives a body the download client truncated at 200 characters", () => {
    const truncated = 'X (HTTP 403): {"error":"A very long explanation that got cut off in the midd';
    const b = extractServerBody(truncated);
    expect(b.error).toBe("A very long explanation that got cut off in the midd");
    const withCode = 'X (HTTP 429): {"code":"DOWNLOAD_LIMIT_EXCEEDED","error":"Download limit reached: 10 differ';
    expect(extractServerBody(withCode).code).toBe("DOWNLOAD_LIMIT_EXCEEDED");
  });

  it("leaves a message with no body alone", () => {
    expect(extractServerBody("fetch failed")).toEqual({ rest: "fetch failed" });
    expect(extractServerBody("odd { brace but no json")).toEqual({ rest: "odd { brace but no json" });
  });
});

describe("describeLaunchError — the known shapes", () => {
  it("the screenshot error: a pinned build on the free plan → change the version", () => {
    const n = describeLaunchError(SCREENSHOT);
    expect(n.tone).toBe("error");
    expect(n.title).toBe("Pinned builds need Pro");
    expect(n.action).toEqual({ kind: "edit", field: "browserVersion" });
    expect(n.raw).toBe(SCREENSHOT); // "Copy details" copies the original, verbatim
    expect(n.lines.join(" ")).not.toMatch(/[{}"]/); // no raw JSON on the card
  });

  it("the manager's own FREE_LATEST_ONLY message names the pinned build", () => {
    const n = describeLaunchError(
      'Could not obtain the browser: This profile is pinned to Clearcote 151.0.7922.108-r18, but the free plan always runs the latest build. Edit the profile and set Browser version to "Latest" (pinning a version is a Pro feature).',
    );
    expect(n.title).toBe("Pinned builds need Pro");
    expect(n.lines[0]).toContain("build 151.0.7922.108-r18");
    expect(n.action).toEqual({ kind: "edit", field: "browserVersion" });
  });

  it("a licence over its browser limit (code from the lease) → try again", () => {
    const n = describeLaunchError("Concurrency limit reached (1/1 in use).", "CONCURRENCY_LIMIT_EXCEEDED");
    expect(n.title).toBe("Your plan's browser limit is reached");
    expect(n.lines[0]).toBe("Concurrency limit reached (1/1 in use).");
    expect(n.action).toEqual({ kind: "retry" });
  });

  it("a rejected key → licence settings", () => {
    for (const msg of [
      'Could not obtain the browser: PRO download not authorized (HTTP 401): {"error":"Invalid license key.","code":"INVALID_LICENSE"}',
      "Could not obtain the browser: PRO download not authorized (HTTP 401): Missing or malformed license key.",
    ]) {
      const n = describeLaunchError(msg);
      expect(n.title, msg).toBe("Your licence key wasn't accepted");
      expect(n.action).toEqual({ kind: "settings", section: "license" });
    }
  });

  it("an expired or revoked licence → licence settings, with the server's words", () => {
    const n = describeLaunchError("This license has expired.", "LICENSE_EXPIRED");
    expect(n.title).toBe("Your licence isn't active");
    expect(n.lines).toEqual(["This license has expired."]);
    expect(n.action).toEqual({ kind: "settings", section: "license" });
    expect(describeLaunchError("revoked", "LICENSE_REVOKED").title).toBe("Your licence isn't active");
  });

  it("the daily download cap", () => {
    const n = describeLaunchError(
      'Could not obtain the browser: PRO download not authorized (HTTP 429): {"error":"Download limit reached: 10 different builds per 24 hours on this plan.","code":"DOWNLOAD_LIMIT_EXCEEDED"}',
    );
    expect(n.title).toBe("Today's download limit is reached");
    expect(n.lines[0]).toMatch(/^Download limit reached/);
    expect(n.action).toBeUndefined();
  });

  it("a Pro build with no key → licence settings", () => {
    for (const msg of [
      "Could not obtain the browser: Clearcote 153.0.8010.36 is a PRO build — set a license key in Settings to use it (the free build is 149.0.7827.114).",
      "Could not obtain the browser: No license key — cannot fetch the PRO build.",
    ]) {
      const n = describeLaunchError(msg);
      expect(n.title, msg).toBe("This profile needs a licence key");
      expect(n.action).toEqual({ kind: "settings", section: "license" });
      expect(n.lines[0]).not.toContain("the free build is");
    }
  });

  it("a version that does not exist → change the version, listing what does", () => {
    const n = describeLaunchError('Could not obtain the browser: No build matches "148". Available: 153 (pro), 149 (free).');
    expect(n.title).toBe("There's no build “148”");
    expect(n.lines[0]).toBe("Available: 153 (pro), 149 (free).");
    expect(n.action).toEqual({ kind: "edit", field: "browserVersion" });
  });

  it("a damaged download → try again (it was discarded)", () => {
    for (const msg of [
      "Could not obtain the browser: PRO archive SHA-256 mismatch — refusing to use it.\n  expected aa\n  got      bb",
      "Could not obtain the browser: PRO archive size mismatch — expected 10 bytes, got 5. Please retry.",
    ]) {
      const n = describeLaunchError(msg);
      expect(n.title, msg).toBe("The browser download was damaged");
      expect(n.action).toEqual({ kind: "retry" });
    }
  });

  it("no network → try again", () => {
    for (const msg of [
      "Could not obtain the browser: fetch failed",
      "Could not obtain the browser: Version catalog fetch failed (HTTP 502).",
      "Could not reach the license server and no valid cached token: TypeError: fetch failed",
      "getaddrinfo ENOTFOUND www.clearcotelabs.com",
    ]) {
      const n = describeLaunchError(msg);
      expect(n.title, msg).toBe("Couldn't reach Clearcote's servers");
      expect(n.action).toEqual({ kind: "retry" });
    }
  });

  it("a spawn failure points at the browser settings (a custom binary is the usual cause)", () => {
    const n = describeLaunchError("Error: spawn C:\\gone\\chrome.exe ENOENT");
    expect(n.title).toBe("The browser couldn't be started");
    expect(n.action).toEqual({ kind: "settings", section: "browser" });
  });

  it("an invalid shader dialect → edit that field (the real withShaderDialect message)", async () => {
    const { withShaderDialect } = await import("../electron/shaderdialect");
    let real = "";
    try {
      withShaderDialect("dx9", {});
    } catch (e) {
      real = String((e as Error).message); // exactly what launcher.ts returns as `error`
    }
    expect(real).toMatch(/shaderDialect/);
    const n = describeLaunchError(real);
    expect(n.title).toBe("The shader dialect setting is invalid");
    expect(n.action).toEqual({ kind: "edit", field: "shaderDialect" });
  });

  it("already running, and the browser-preview message", () => {
    expect(describeLaunchError("This profile is already running.").title).toBe("This profile is already running");
    const prev = describeLaunchError("Launching only works in the desktop app (this is the browser preview).");
    expect(prev.tone).toBe("warning");
    expect(prev.title).toBe("Launching only works in the desktop app.");
  });

  it("anything unrecognised still reads as a sentence, with the server message unwrapped", () => {
    const n = describeLaunchError('Could not obtain the browser: Weird thing (HTTP 418): {"error":"I am a teapot."}');
    expect(n.title).toBe("Launch failed");
    expect(n.lines).toEqual(["Weird thing (HTTP 418): I am a teapot."]);
    expect(describeLaunchError(undefined).lines).toEqual(["No reason was given."]);
    expect(describeLaunchError("").raw).toBeUndefined();
  });
});

describe("describeLaunchWarnings", () => {
  it("is a warning, counts correctly, and keeps every warning", () => {
    expect(describeLaunchWarnings(["a"])).toEqual({ tone: "warning", title: "Launched, with a warning", lines: ["a"] });
    expect(describeLaunchWarnings(["a", "b"]).title).toBe("Launched, with 2 warnings");
  });
});

describe("actionLabel", () => {
  it("names each action", () => {
    expect(actionLabel({ kind: "retry" })).toBe("Try again");
    expect(actionLabel({ kind: "settings", section: "license" })).toBe("Licence settings");
    expect(actionLabel({ kind: "settings", section: "browser" })).toBe("Browser settings");
    expect(actionLabel({ kind: "edit", field: "browserVersion" })).toBe("Change version");
    expect(actionLabel({ kind: "edit", field: "shaderDialect" })).toBe("Edit profile");
  });
});
