// helper/policy.ts — what a paired web page still may not do: Chrome switches that run programs,
// write files or open DevTools; another data folder or a fingerprint path; reading the keys; or
// changing which binary runs and where licence/cloud calls go.

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile, Settings } from "../electron/types";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-helper-policy-"));
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

type Mod = typeof import("../helper/policy");
let m: Mod;
beforeAll(async () => {
  m = await import("../helper/policy");
});
afterAll(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const base = (over: Partial<Profile> = {}): Profile =>
  ({ id: "p1", name: "One", fingerprint: "seed", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...over }) as Profile;

describe("refusedArgs", () => {
  it("lets ordinary switches and web start pages through", () => {
    expect(m.refusedArgs(undefined)).toEqual([]);
    expect(m.refusedArgs(["--disable-features=Foo", "--lang=de", "--start-maximized", "https://example.com", "http://x.test/a"])).toEqual([]);
  });

  it("refuses switches that run programs, take a file or folder, or weaken the sandbox", () => {
    const bad = [
      "--renderer-cmd-prefix=calc.exe",
      "--utility-cmd-prefix=x",
      "--gpu-launcher=x",
      "--browser-subprocess-path=C:\\x.exe",
      "--log-file=C:\\x",
      "--disk-cache-dir=C:\\x",
      "--user-data-dir=C:\\other",
      "--profile-directory=Default",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--disable-setuid-sandbox",
      "--remote-debugging-address=0.0.0.0",
      "--remote-debugging-port=9222",
      "--remote-debugging-pipe",
      "--remote-allow-origins=*",
      "--load-extension=C:\\ext",
      "--disable-extensions-except=C:\\ext",
    ];
    for (const a of bad) expect(m.refusedArgs([a]), a).toEqual([a]);
  });

  it("is not fooled by upper case (Chromium lower-cases switch names on Windows)", () => {
    expect(m.refusedArgs(["--No-Sandbox"])).toEqual(["--No-Sandbox"]);
    expect(m.refusedArgs(["--Remote-Debugging-Port=9222"])).toEqual(["--Remote-Debugging-Port=9222"]);
    expect(m.refusedArgs(["--RENDERER-CMD-PREFIX=x"])).toEqual(["--RENDERER-CMD-PREFIX=x"]);
  });

  it("refuses bare arguments that are not web addresses (single-dash and slash switches too)", () => {
    for (const a of ["file:///C:/Windows/win.ini", "C:\\evil.html", "-no-sandbox", "/no-sandbox", "javascript:alert(1)"]) {
      expect(m.refusedArgs([a]), a).toEqual([a]);
    }
  });

  it("refuses a non-array outright", () => {
    expect(m.refusedArgs("--no-sandbox")).toEqual(["--no-sandbox"]);
  });

  it("keeps what this computer already set", () => {
    expect(m.refusedArgs(["--no-sandbox", "--lang=de"], ["--no-sandbox"])).toEqual([]);
    expect(m.refusedArgs(["--no-sandbox", "--gpu-launcher=x"], ["--no-sandbox"])).toEqual(["--gpu-launcher=x"]);
  });
});

describe("tasks:saveSteps", () => {
  it("refuses steps that run JavaScript, at any depth, and passes the rest on", async () => {
    const seen: unknown[] = [];
    const h = m.webPolicy({ "tasks:saveSteps": async (_c: unknown, id: unknown, steps: unknown) => (seen.push([id, steps]), { ok: true }) } as never);
    const ctx = { emit() {} };
    const js = [{ kind: "if", condition: { type: "text", value: "x" }, then: [{ kind: "js", code: "alert(1)" }] }];
    expect(await h["tasks:saveSteps"](ctx, "t1", js)).toMatchObject({ ok: false, error: expect.stringMatching(/JavaScript/) });
    expect(await h["tasks:saveSteps"](ctx, "t1", [{ kind: "wait_for", condition: { type: "js", value: "true" } }])).toMatchObject({ ok: false });
    expect(await h["tasks:saveSteps"](ctx, "t1", [{ kind: "click", label: "Go" }])).toEqual({ ok: true });
    expect(seen).toEqual([["t1", [{ kind: "click", label: "Go" }]]]);
  });
});

describe("cleanProfile", () => {
  it("keeps extensions as IDs only", () => {
    const ok = "nkbihfbeogaeaoehlefnkodbefgpgknn";
    const out = m.cleanProfile(base({ extensions: [ok, "C:\evil", "../x", 42 as never] }), null);
    expect(out.extensions).toEqual([ok]);
    expect(m.cleanProfile(base({ extensions: "x" as never }), null).extensions).toEqual([]);
  });

  it("keeps the stored data folder and ignores one from the page", () => {
    const stored = base({ userDataDir: "D:\\Profiles\\one" });
    expect(m.cleanProfile(base({ userDataDir: "C:\\Windows" }), stored).userDataDir).toBe("D:\\Profiles\\one");
    expect("userDataDir" in m.cleanProfile(base({ userDataDir: "C:\\Windows" }), null)).toBe(false);
    expect("userDataDir" in m.cleanProfile(base({ userDataDir: "C:\\Windows" }), base())).toBe(false);
  });

  it("accepts a fingerprint by name, refuses a path, keeps the stored one", () => {
    expect(m.cleanProfile(base({ fingerprintProfile: "rtx4070.json" }), null).fingerprintProfile).toBe("rtx4070.json");
    for (const f of ["../../secret.json", "C:\\x.json", "/etc/passwd", "sub/x.json", "c:x.json"]) {
      expect(() => m.cleanProfile(base({ fingerprintProfile: f }), null), f).toThrow(/fingerprint/);
    }
    const stored = base({ fingerprintProfile: "D:\\set\\here.json" });
    expect(m.cleanProfile(base({ fingerprintProfile: "D:\\set\\here.json" }), stored).fingerprintProfile).toBe("D:\\set\\here.json");
  });

  it("refuses risky extraArgs with a message, keeps stored ones", () => {
    expect(() => m.cleanProfile(base({ extraArgs: ["--renderer-cmd-prefix=x"] }), null)).toThrow(/cannot set --renderer-cmd-prefix=x/);
    const stored = base({ extraArgs: ["--no-sandbox"] });
    expect(m.cleanProfile(base({ extraArgs: ["--no-sandbox", "--lang=de"] }), stored).extraArgs).toEqual(["--no-sandbox", "--lang=de"]);
  });

  it("refuses something that is not a profile", () => {
    expect(() => m.cleanProfile(null as unknown as Profile, null)).toThrow();
    expect(() => m.cleanProfile("x" as unknown as Profile, null)).toThrow();
  });

  it("does not change the object it was given", () => {
    const p = base({ userDataDir: "C:\\x" });
    m.cleanProfile(p, null);
    expect(p.userDataDir).toBe("C:\\x");
  });
});

describe("maskSettings / cleanSettings", () => {
  const saved: Settings = {
    licenseKey: "cc_lic_abcdefghijklmnop1234",
    cloudApiKey: "cc_live_zyxwvutsrqpo9876",
    binaryPath: "D:\\cc\\chrome.exe",
    licenseApiBase: "https://www.clearcotelabs.com",
    cloudApiBase: "https://www.clearcotelabs.com",
    theme: "dark",
  };

  it("masks both keys, keeping only a prefix and the last 4", () => {
    const s = m.maskSettings(saved);
    expect(s.licenseKey).not.toBe(saved.licenseKey);
    expect(s.licenseKey!.startsWith("cc_lic_")).toBe(true);
    expect(s.licenseKey!.endsWith("1234")).toBe(true);
    expect(s.licenseKey).not.toContain("abcdefghijklmnop");
    expect(s.cloudApiKey).not.toContain("zyxwvutsrqpo");
    expect(s.binaryPath).toBe(saved.binaryPath);
    expect(m.maskSettings({ theme: "light" }).licenseKey).toBeUndefined();
  });

  it("a masked key sent back means keep the saved one; a new key replaces it", () => {
    const back = m.cleanSettings(m.maskSettings(saved), saved);
    expect(back.licenseKey).toBe(saved.licenseKey);
    expect(back.cloudApiKey).toBe(saved.cloudApiKey);
    const fresh = m.cleanSettings({ ...m.maskSettings(saved), licenseKey: "cc_lic_new" }, saved);
    expect(fresh.licenseKey).toBe("cc_lic_new");
    const cleared = m.cleanSettings({ ...m.maskSettings(saved), cloudApiKey: "" }, saved);
    expect(cleared.cloudApiKey).toBe("");
  });

  it("keeps binaryPath and the API bases as saved, whatever the page sends", () => {
    const s = m.cleanSettings({ binaryPath: "C:\\evil.exe", licenseApiBase: "https://evil.com", cloudApiBase: "https://evil.com", theme: "light" }, saved);
    expect(s.binaryPath).toBe(saved.binaryPath);
    expect(s.licenseApiBase).toBe(saved.licenseApiBase);
    expect(s.cloudApiBase).toBe(saved.cloudApiBase);
    expect(s.theme).toBe("light");
    const none = m.cleanSettings({ binaryPath: "C:\\evil.exe" }, { theme: "dark" });
    expect(none.binaryPath).toBeUndefined();
  });
});

describe("webPolicy", () => {
  it("launches the stored profile, not the page's copy, and refuses an unsaved one", async () => {
    const profiles = await import("../electron/profiles");
    const saved = profiles.saveProfile(base({ id: "polp1", extraArgs: [] }));
    const seen: Profile[] = [];
    const h = m.webPolicy({ launch: (_c, p: Profile) => (seen.push(p), { ok: true }) });
    const ctx = { emit: () => {} };
    await h.launch(ctx, { ...saved, extraArgs: ["--renderer-cmd-prefix=calc"], userDataDir: "C:\\x" });
    expect(seen[0].extraArgs ?? []).toEqual([]);
    expect(seen[0].userDataDir).toBeUndefined();
    expect(() => h.launch(ctx, base({ id: "never-saved" }))).toThrow(/Save the profile first/);
  });

  it("cleans every imported profile", async () => {
    const got: string[] = [];
    const h = m.webPolicy({ "profiles:importData": (_c, json: string) => (got.push(json), { ok: true }) });
    const ctx = { emit: () => {} };
    expect(() => h["profiles:importData"](ctx, JSON.stringify([base({ extraArgs: ["--no-sandbox"] })]))).toThrow(/cannot set/);
    await h["profiles:importData"](ctx, JSON.stringify(base({ userDataDir: "C:\\x" })));
    expect(JSON.parse(got[0])[0].userDataDir).toBeUndefined();
  });

  it("clearing several profiles' data goes to the same handler as one profile's cache, unchanged", async () => {
    const got: unknown[][] = [];
    const h = m.webPolicy({
      "profiles:clearCache": (_c, ...a: unknown[]) => (got.push(["one", ...a]), { ok: true }),
      "storage:clearProfiles": (_c, ...a: unknown[]) => (got.push(["many", ...a]), { freedBytes: 0 }),
    });
    const ctx = { emit: () => {} };
    await h["profiles:clearCache"](ctx, "p");
    await h["storage:clearProfiles"](ctx, ["p", "q"], "all");
    expect(got).toEqual([
      ["one", "p"],
      ["many", ["p", "q"], "all"],
    ]);
  });
});

describe("run a task from the web version", () => {
  const calls: { ch: string; args: unknown[] }[] = [];
  const CHANNELS = ["sync:list", "sync:start", "sync:approve", "sync:cancel", "sync:stop", "sync:clear", "tasks:list", "tasks:save", "tasks:delete", "jet:status", "jet:install", "jet:checkKey", "cdp:endpoint"];
  // A plain object (not a Proxy): webPolicy spreads the handlers, and a spread sees own keys only.
  const fake = Object.fromEntries(
    CHANNELS.map((ch) => [
      ch,
      (_c: unknown, ...args: unknown[]) => {
        calls.push({ ch, args });
        return { ok: true };
      },
    ]),
  );
  const ctx = { emit: () => {} };

  it("reaches runs, saved tasks and Jet setup like the desktop app", async () => {
    const h = m.webPolicy(fake as never);
    calls.length = 0;
    for (const ch of ["sync:list", "sync:approve", "sync:cancel", "sync:stop", "sync:clear", "tasks:list", "tasks:save", "tasks:delete", "jet:status", "jet:install"]) {
      expect(await h[ch](ctx, "x"), ch).toEqual({ ok: true });
    }
    expect(calls.map((c) => c.ch)).toEqual(["sync:list", "sync:approve", "sync:cancel", "sync:stop", "sync:clear", "tasks:list", "tasks:save", "tasks:delete", "jet:status", "jet:install"]);
  });

  it("starts a run by profile ids only", async () => {
    const h = m.webPolicy(fake as never);
    calls.length = 0;
    await h["sync:start"](ctx, { profileIds: ["shop-01"], goal: "Log in" });
    expect(calls[0]).toEqual({ ch: "sync:start", args: [{ profileIds: ["shop-01"], goal: "Log in" }] });
    expect(() => h["sync:start"](ctx, { profileIds: ["../etc"], goal: "x" })).toThrow(/Not a profile id/);
    expect(() => h["sync:start"](ctx, null)).toThrow(/Not a task run/);
  });

  it("checks the saved Jet key when the masked one comes back", async () => {
    const h = m.webPolicy(fake as never);
    calls.length = 0;
    await h["jet:checkKey"](ctx, m.maskSettings({ jetApiKey: "tsk_live_1234567890abcd" } as Settings).jetApiKey);
    await h["jet:checkKey"](ctx, "tsk_new_key");
    expect(calls.map((c) => c.args[0])).toEqual([undefined, "tsk_new_key"]);
  });

  it("never hands out a browser's DevTools endpoint", async () => {
    const h = m.webPolicy(fake as never);
    calls.length = 0;
    const r = (await h["cdp:endpoint"](ctx, "shop-01")) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/DevTools endpoint/);
    expect(calls).toEqual([]);
  });

  it("cannot change which program Jet is or turn automation on, and sees Jet's key masked", () => {
    const saved: Settings = { jetCommand: "clearcote-jet", automation: false, jetApiKey: "tsk_live_1234567890abcd" };
    const out = m.cleanSettings({ jetCommand: "calc.exe", automation: true, jetApiKey: m.maskSettings(saved).jetApiKey } as Settings, saved);
    expect(out.jetCommand).toBe("clearcote-jet");
    expect(out.automation).toBe(false);
    expect(out.jetApiKey).toBe("tsk_live_1234567890abcd");
    expect(m.maskSettings(saved).jetApiKey).not.toBe(saved.jetApiKey);
    expect(m.maskSettings(saved).jetApiKey).toContain("••••");
  });
});
