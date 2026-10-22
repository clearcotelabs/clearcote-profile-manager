// What a web page may NOT do through the helper, even when paired.
//
// The desktop app trusts its own window: whoever sits at it can already run anything. A web page is
// different, so the helper wraps the shared handlers with these rules:
//   - It cannot choose which program runs: binaryPath, and where the licence and cloud calls go
//     (licenseApiBase, cloudApiBase), are kept as they are on this computer.
//   - It cannot pass Chrome switches that run programs or write wherever they like
//     (--renderer-cmd-prefix, --gpu-launcher, --log-file=…, --no-sandbox, …).
//   - It cannot point a profile at another folder (userDataDir) or a fingerprint file elsewhere.
//   - Launches use the profile as saved on this computer, not whatever the page sends.
//   - It sees the licence and API keys masked (it can replace them, not read them).
// Everything set in the desktop app on this computer stays as it is.

import * as profiles from "../electron/profiles";
import { readSettings } from "../electron/store";
import type { Handler } from "../electron/handlers";
import type { Profile, Settings } from "../electron/types";

/** A switch whose name says it runs something or takes a file or folder. */
const RISKY_NAME = /(cmd-prefix|launcher|subprocess|gdb|wrapper|-file|-dir|-path|^--user-data|^--profile-directory)/i;
const RISKY_EXACT = new Set([
  "--no-sandbox", "--remote-debugging-address", "--single-process", "--no-zygote", "--disable-setuid-sandbox",
  // DevTools on a port the page could then connect to (with --remote-allow-origins): full control of
  // the browser, file:// reads included. Extensions load code from a folder.
  "--remote-debugging-port", "--remote-debugging-pipe", "--remote-allow-origins", "--load-extension",
  "--disable-extensions-except",
  // Lets every site in that browser read every other site, and local files.
  "--disable-web-security", "--allow-file-access-from-files",
]);

/** The extraArgs a web page asked for that it may not set, or [] when all are fine. */
export function refusedArgs(args: unknown, alreadySet: string[] = []): string[] {
  if (args === undefined) return [];
  if (!Array.isArray(args)) return [String(args)];
  const out: string[] = [];
  for (const raw of args) {
    const a = String(raw);
    if (alreadySet.includes(a)) continue; // set on this computer: not the page's doing
    if (!a.startsWith("--")) {
      // A bare argument opens as a page; only web addresses.
      if (!/^https?:\/\//i.test(a)) out.push(a);
      continue;
    }
    // Chromium on Windows lower-cases switch names, so --No-Sandbox is --no-sandbox.
    const name = a.split("=")[0].toLowerCase();
    if (RISKY_EXACT.has(name) || RISKY_NAME.test(name)) out.push(a);
  }
  return out;
}

const isBareName = (f: string) => !/[\\/]/.test(f) && !f.includes("..") && !/^[a-z]:/i.test(f);

/** A profile from the page, made safe against what this computer has saved for it. */
export function cleanProfile(incoming: Profile, stored: Profile | null): Profile {
  if (!incoming || typeof incoming !== "object") throw new Error("Not a profile.");
  const p: Profile = { ...incoming };
  // Where its browser data lives is decided on this computer.
  if (stored?.userDataDir) p.userDataDir = stored.userDataDir;
  else delete p.userDataDir;
  if (p.fingerprintProfile && p.fingerprintProfile !== stored?.fingerprintProfile && !isBareName(p.fingerprintProfile)) {
    throw new Error("A fingerprint must be one from the library or imported here, not a path.");
  }
  const refused = refusedArgs(p.extraArgs, stored?.extraArgs ?? []);
  if (refused.length) {
    throw new Error(
      `The web version cannot set ${refused.join(" ")}: switches like these can run programs or write files. ` +
        "Set them in the desktop app if you need them.",
    );
  }
  return p;
}

const MASK = "••••";
const mask = (v?: string) => (v ? `${v.slice(0, 7)}${MASK}${v.slice(-4)}` : v);

/** Settings as a web page sees them: keys masked. */
export function maskSettings(s: Settings): Settings {
  return { ...s, licenseKey: mask(s.licenseKey), cloudApiKey: mask(s.cloudApiKey) };
}

/** Settings from a web page: the parts that decide what runs and where keys go stay as saved. */
export function cleanSettings(incoming: Settings, saved: Settings): Settings {
  const s: Settings = { ...incoming };
  s.binaryPath = saved.binaryPath;
  s.licenseApiBase = saved.licenseApiBase;
  s.cloudApiBase = saved.cloudApiBase;
  // A masked key coming back unchanged means "keep it".
  if (s.licenseKey?.includes(MASK)) s.licenseKey = saved.licenseKey;
  if (s.cloudApiKey?.includes(MASK)) s.cloudApiKey = saved.cloudApiKey;
  return s;
}

/** The shared handlers with the rules above applied. */
export function webPolicy(h: Record<string, Handler>): Record<string, Handler> {
  const stored = (id: string) => (profiles.isSafeId(String(id)) ? profiles.getProfile(String(id)) : null);
  const savedFirst = (p: Profile) => {
    const s = stored(p?.id);
    if (!s) throw new Error("Save the profile first.");
    return s;
  };
  return {
    ...h,
    "profiles:save": (c, p: Profile) => h["profiles:save"](c, cleanProfile(p, stored(p?.id))),
    launch: (c, p: Profile) => h.launch(c, savedFirst(p)),
    "cloud:start": (c, p: Profile) => h["cloud:start"](c, savedFirst(p)),
    "profiles:importData": (c, json: string) => {
      const data = JSON.parse(String(json));
      const list = (Array.isArray(data) ? data : [data]).map((p: Profile) => cleanProfile(p, null));
      return h["profiles:importData"](c, JSON.stringify(list));
    },
    // A masked key from the Settings form means "the saved one".
    "license:check": (c, key?: string) => h["license:check"](c, key?.includes(MASK) ? undefined : key),
    "cloud:account": (c, key?: string) => h["cloud:account"](c, key?.includes(MASK) ? undefined : key),
    "settings:get": async (c) => maskSettings((await h["settings:get"](c)) as Settings),
    "settings:set": async (c, s: Settings) => maskSettings((await h["settings:set"](c, cleanSettings(s, readSettings()))) as Settings),
  };
}
