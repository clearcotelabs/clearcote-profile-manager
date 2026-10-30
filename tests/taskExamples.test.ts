// The task examples (src/lib/taskExamples.ts): unique ids, known categories, goals whose {{slots}} are all
// well formed (what the dialog and Jet read), "same for all" slots that the goal really uses, start pages
// that are http(s), the chips in Run a task, and a translation of every title and category in every locale.
import { describe, expect, it } from "vitest";
import { EXAMPLE_CATEGORIES, FEATURED_EXAMPLES, TASK_EXAMPLES, exampleById } from "../src/lib/taskExamples";
import { templateSlots } from "../electron/jetslots";
import de from "../src/lib/i18n/de.json";
import es from "../src/lib/i18n/es.json";
import fr from "../src/lib/i18n/fr.json";
import ja from "../src/lib/i18n/ja.json";
import ptBr from "../src/lib/i18n/pt-br.json";
import vi from "../src/lib/i18n/vi.json";
import zh from "../src/lib/i18n/zh.json";

const CATALOGS: Record<string, Record<string, string>> = { zh, ja, "pt-br": ptBr, de, es, fr, vi };

describe("task examples", () => {
  it("has plenty, in every category, with unique ids and titles", () => {
    expect(TASK_EXAMPLES.length).toBeGreaterThanOrEqual(30);
    const ids = TASK_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const titles = TASK_EXAMPLES.map((e) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
    const cats = EXAMPLE_CATEGORIES.map((c) => c.id) as string[];
    for (const e of TASK_EXAMPLES) expect(cats).toContain(e.category);
    for (const c of cats) expect(TASK_EXAMPLES.filter((e) => e.category === c).length).toBeGreaterThanOrEqual(3);
  });

  it("writes every value as a well-formed {{slot}}", () => {
    for (const e of TASK_EXAMPLES) {
      // Every pair of braces in the goal is a slot templateSlots reads, written the one way ({{name}}, no spaces).
      const braces = [...e.goal.matchAll(/\{+[^{}]*\}+/g)].map((m) => m[0]);
      expect(braces.every((b) => /^\{\{[A-Za-z_][\w.-]{0,63}\}\}$/.test(b)), `${e.id}: ${braces.join(" ")}`).toBe(true);
      expect(templateSlots(e.goal).length).toBe(new Set(braces).size);
      expect(e.goal.replace(/\{\{[^{}]*\}\}/g, ""), e.id).not.toMatch(/[{}]/);
    }
  });

  it("marks only slots the goal uses as the same for every profile", () => {
    for (const e of TASK_EXAMPLES) for (const s of e.same ?? []) expect(templateSlots(e.goal), e.id).toContain(s);
  });

  it("starts on an http(s) page or leaves it to the user", () => {
    for (const e of TASK_EXAMPLES) expect(e.url === "https://" || /^https:\/\/[\w.-]+(\/\S*)?$/.test(e.url), e.id).toBe(true);
  });

  it("features existing examples, Log in first and the only one titled so (the UI e2e clicks it)", () => {
    const featured = FEATURED_EXAMPLES.map(exampleById);
    expect(featured.every(Boolean)).toBe(true);
    expect(featured[0]?.title).toBe("Log in");
    expect(templateSlots(featured[0]!.goal)).toEqual(["email", "password"]);
    expect(featured.filter((e) => /log in/i.test(e!.title))).toHaveLength(1);
  });

  for (const [locale, cat] of Object.entries(CATALOGS)) {
    it(`${locale}: translates every title and category`, () => {
      const keys = [...EXAMPLE_CATEGORIES.map((c) => c.title), ...TASK_EXAMPLES.map((e) => e.title)];
      expect(keys.filter((k) => typeof cat[k] !== "string" || !cat[k].trim())).toEqual([]);
    });
  }
});
