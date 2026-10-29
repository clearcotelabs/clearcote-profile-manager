// The UI translations: every message the code uses (src/lib/i18n/messages.json, written by
// `npm run i18n:extract`) has a translation in every locale, with the same {placeholders} and <tags>.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { LOCALES, matchLocale, setLocale, t, tRich } from "../src/lib/i18n";
import de from "../src/lib/i18n/de.json";
import es from "../src/lib/i18n/es.json";
import fr from "../src/lib/i18n/fr.json";
import ja from "../src/lib/i18n/ja.json";
import ptBr from "../src/lib/i18n/pt-br.json";
import vi from "../src/lib/i18n/vi.json";
import zh from "../src/lib/i18n/zh.json";
import messages from "../src/lib/i18n/messages.json";
// @ts-expect-error plain .mjs script without types
import { extract } from "../scripts/i18n-extract.mjs";

const keys = Object.keys(messages);
const CATALOGS: Record<string, Record<string, string>> = { zh, ja, "pt-br": ptBr, de, es, fr, vi };
const tokens = (s: string) => [...s.matchAll(/\{\w+\}|<\/?\w+>/g)].map((m) => m[0]).sort();

describe("i18n catalogs", () => {
  it("messages.json is current (run `npm run i18n:extract` after changing UI text)", () => {
    const { keys: live } = extract() as { keys: Map<string, Set<string>> };
    expect([...live.keys()].sort()).toEqual([...keys].sort());
  });

  for (const [locale, cat] of Object.entries(CATALOGS)) {
    it(`${locale}: translates every message`, () => {
      const missing = keys.filter((k) => typeof cat[k] !== "string" || cat[k].trim() === "");
      expect(missing).toEqual([]);
    });

    it(`${locale}: keeps every placeholder and tag`, () => {
      const bad = keys.filter((k) => cat[k] && tokens(cat[k]).join() !== tokens(k).join());
      expect(bad).toEqual([]);
    });

    it(`${locale}: has no unused entries`, () => {
      expect(Object.keys(cat).filter((k) => !(k in messages))).toEqual([]);
    });
  }
});

describe("i18n runtime", () => {
  it("maps browser languages to ours", () => {
    expect(matchLocale("de-AT")).toBe("de");
    expect(matchLocale("pt-PT")).toBe("pt-br");
    expect(matchLocale("zh-TW")).toBe("zh");
    expect(matchLocale("nl-NL")).toBeNull();
    expect(LOCALES).toContain("vi");
  });

  it("translates, fills placeholders and falls back to English", async () => {
    await setLocale("en");
    expect(t("Deleted {n} profiles", { n: 3 })).toBe("Deleted 3 profiles");
    expect(t("Cancel")).toBe("Cancel");
    await setLocale("de");
    expect(t("Cancel")).toBe(de["Cancel" as keyof typeof de]);
    expect(t("Cancel")).not.toBe("Cancel");
    expect(t("a message nobody translated")).toBe("a message nobody translated");
    await setLocale("en");
  });

  it("renders rich text", () => {
    const node = tRich("Press <b>Launch</b> now {x}", { b: (s) => createElement("strong", null, s), x: "!" });
    expect(renderToStaticMarkup(createElement("p", null, node))).toBe("<p>Press <strong>Launch</strong> now !</p>");
  });
});
