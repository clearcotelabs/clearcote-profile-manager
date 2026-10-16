// Linux only: point the browser at the font bundle it ships, the way the SDK does on every launch.
//
// A Linux build carries `fonts/` next to the binary: metric-compatible stand-ins for the Windows
// families plus a self-contained `fonts.conf.template`. The SDK fills the template in and sets
// FONTCONFIG_FILE; this app never did, so every Linux launch from it rendered with the HOST's fonts —
// other text widths than the persona claims, and every host font reachable through glyph fallback even
// where the persona hides its name. Mirrors the SDK's linuxFontEnv + linuxLocaleEnv (sdk/node/src/fonts.ts)
// without its CLEARCOTE_FONT_DIRS extras: the file goes next to the binary first, then the user's cache,
// then a private temp directory; a launch is never blocked on font wiring.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the config goes when the binary's directory is not writable (the SDK's userConfDir). */
export function userConfDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLEARCOTE_CACHE) return path.join(env.CLEARCOTE_CACHE, "fontconfig");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "clearcote", "fontconfig");
}

/** The template with its two placeholders filled in. */
export function buildConf(template: string, fontsDir: string, cacheDir: string): string {
  return template.split("@FONTS_DIR@").join(fontsDir).split("@CACHE_DIR@").join(cacheDir);
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    throw e;
  }
}

let privateTmp: string | undefined;
function privateTmpDir(): string {
  if (!privateTmp) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fontconfig-"));
    process.once("exit", () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    privateTmp = dir;
  }
  return privateTmp;
}

/**
 * `{ FONTCONFIG_FILE }` for a Linux binary that ships a font bundle; `{}` elsewhere, for a build without
 * one, or when no location can be written (then `warn` says why — the browser falls back to host fonts).
 */
export function linuxFontEnv(
  exePath: string,
  warn: (m: string) => void = () => {},
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  if (platform !== "linux") return {};
  const fontsDir = path.join(path.dirname(exePath), "fonts");
  const template = path.join(fontsDir, "fonts.conf.template");
  if (!fs.existsSync(template)) return {};
  const cacheDir = path.join(os.tmpdir(), "cc-fc-cache");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    /* fontconfig works without a cache, only slower */
  }
  let conf: string;
  try {
    conf = buildConf(fs.readFileSync(template, "utf8"), fontsDir, cacheDir);
  } catch (e) {
    warn(`The browser's font config template could not be read (${(e as Error).message}); it will use this machine's fonts.`);
    return {};
  }
  const tried: string[] = [];
  const candidates: [() => string, string][] = [
    [() => fontsDir, "fonts.generated.conf"],
    [() => userConfDir(), "fonts.generated.conf"],
    [privateTmpDir, "fonts.generated.conf"],
  ];
  for (const [where, name] of candidates) {
    let dir = "a private temp directory";
    try {
      dir = where();
      if (dir !== fontsDir) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, name);
      writeAtomic(file, conf);
      return { FONTCONFIG_FILE: file };
    } catch (e) {
      tried.push(`${dir} (${(e as Error).message})`);
    }
  }
  warn(
    `The browser's font config could not be written (${tried.join("; ")}), so it will render with this machine's fonts instead of its own bundle.`,
  );
  return {};
}

/**
 * LANGUAGE for the Linux UI locale, from the last --lang switch: GTK dialogs and engines before 153 r29
 * read their messages from it, so a German persona on a Linux host still spoke English without it.
 * LANGUAGE only steers message catalogues — unlike LANG/LC_*, it leaves number parsing and fontconfig's
 * default language alone. `de` -> `de`, `en-GB` -> `en_GB`.
 */
export function linuxLocaleEnv(args: readonly string[], platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== "linux") return {};
  let lang: string | undefined;
  for (const a of args) if (a.startsWith("--lang=")) lang = a.slice("--lang=".length).trim();
  return lang ? { LANGUAGE: lang.replace(/-/g, "_") } : {};
}
