// The Linux font bundle wiring (electron/linuxfonts.ts), run against a fake bundle on any host.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConf, linuxFontEnv, linuxLocaleEnv } from "../electron/linuxfonts";

const TEMPLATE = `<?xml version="1.0"?>\n<fontconfig>\n  <dir>@FONTS_DIR@</dir>\n  <cachedir>@CACHE_DIR@</cachedir>\n</fontconfig>\n`;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-fonts-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("linuxFontEnv", () => {
  it("fills the template in next to the binary and points FONTCONFIG_FILE at it", () => {
    fs.mkdirSync(path.join(root, "fonts"));
    fs.writeFileSync(path.join(root, "fonts", "fonts.conf.template"), TEMPLATE);
    const env = linuxFontEnv(path.join(root, "chrome"), undefined, "linux");
    expect(env.FONTCONFIG_FILE).toBe(path.join(root, "fonts", "fonts.generated.conf"));
    const conf = fs.readFileSync(env.FONTCONFIG_FILE, "utf8");
    expect(conf).toContain(`<dir>${path.join(root, "fonts")}</dir>`);
    expect(conf).not.toContain("@FONTS_DIR@");
    expect(conf).not.toContain("@CACHE_DIR@");
  });
  it("does nothing off Linux or for a build without a bundle", () => {
    fs.mkdirSync(path.join(root, "fonts"));
    fs.writeFileSync(path.join(root, "fonts", "fonts.conf.template"), TEMPLATE);
    expect(linuxFontEnv(path.join(root, "chrome"), undefined, "win32")).toEqual({});
    expect(linuxFontEnv(path.join(root, "elsewhere", "chrome"), undefined, "linux")).toEqual({});
  });
});

describe("buildConf", () => {
  it("replaces every placeholder", () => {
    expect(buildConf("@FONTS_DIR@ @FONTS_DIR@ @CACHE_DIR@", "/f", "/c")).toBe("/f /f /c");
  });
});

describe("linuxLocaleEnv", () => {
  it("takes the last --lang, in gettext form", () => {
    expect(linuxLocaleEnv(["--lang=de", "--lang=en-GB"], "linux")).toEqual({ LANGUAGE: "en_GB" });
    expect(linuxLocaleEnv(["--x"], "linux")).toEqual({});
    expect(linuxLocaleEnv(["--lang=de"], "win32")).toEqual({});
  });
});
