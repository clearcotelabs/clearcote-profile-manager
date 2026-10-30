"use client";

// The app's languages: the same set as clearcotelabs.com (site lib/i18n/config.ts). English is the source:
// a message's key IS its English text, so `t("Launch")` reads like the English it shows and a missing
// translation falls back to English by itself. Catalogs: src/lib/i18n/<locale>.json, built by
// `npm run i18n:extract` (see scripts/i18n-extract.mjs); tests/i18n.test.ts keeps them complete.
//
// The language is a per-device preference in localStorage (like the theme): the desktop app and the web
// page each remember their own. With none saved, the browser's language decides.
//
// Placeholders: `t("Deleted {n} profiles", { n })`. Rich text: `tRich("Press <k>Launch</k> to start", { k: (s) => <b>{s}</b> })`.
// Strings that live in module-level tables (labels, help) are marked with `tx("…")` so the extractor finds
// them; translate them where they are shown, `t(field.label)`.

import { Fragment, createElement, useEffect, useSyncExternalStore, type ReactNode } from "react";

export const LOCALES = ["en", "zh", "ja", "pt-br", "de", "es", "fr", "vi"] as const;
export type Locale = (typeof LOCALES)[number];

/** The language's own name (for the picker) and its BCP 47 tag (for <html lang> and Intl). */
export const LOCALE_META: Record<Locale, { nativeName: string; htmlLang: string }> = {
  en: { nativeName: "English", htmlLang: "en" },
  zh: { nativeName: "简体中文", htmlLang: "zh-Hans" },
  ja: { nativeName: "日本語", htmlLang: "ja" },
  "pt-br": { nativeName: "Português (Brasil)", htmlLang: "pt-BR" },
  de: { nativeName: "Deutsch", htmlLang: "de" },
  es: { nativeName: "Español", htmlLang: "es" },
  fr: { nativeName: "Français", htmlLang: "fr" },
  vi: { nativeName: "Tiếng Việt", htmlLang: "vi" },
};

type Catalog = Record<string, string>;

// Each catalog is its own chunk, fetched when its language is picked, so English users (and everyone's
// first paint) don't download the other seven.
const LOADERS: Record<Exclude<Locale, "en">, () => Promise<{ default: Catalog }>> = {
  zh: () => import("./i18n/zh.json"),
  ja: () => import("./i18n/ja.json"),
  "pt-br": () => import("./i18n/pt-br.json"),
  de: () => import("./i18n/de.json"),
  es: () => import("./i18n/es.json"),
  fr: () => import("./i18n/fr.json"),
  vi: () => import("./i18n/vi.json"),
};
const loaded: Partial<Record<Locale, Catalog>> = {};

/** Fetch a language's catalog (once). */
export async function loadLocale(l: Locale): Promise<void> {
  if (l === "en" || loaded[l]) return;
  loaded[l] = (await LOADERS[l]()).default;
}

const STORAGE_KEY = "clearcote.lang";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** Map a browser language tag (navigator.languages entry) to one of ours, or null. */
export function matchLocale(tag: string): Locale | null {
  const t = tag.toLowerCase();
  if (t.startsWith("pt")) return "pt-br"; // one Portuguese version, as on the site
  if (t.startsWith("zh")) return "zh";
  const base = t.split("-")[0];
  return isLocale(base) ? base : null;
}

function initialLocale(): Locale {
  if (typeof window === "undefined") return "en";
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    /* storage blocked: fall through to the browser's language */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const m = tag && matchLocale(tag);
    if (m) return m;
  }
  return "en";
}

// English until the first client render has committed: the web build is prerendered in English, and the
// first client render must match it (hydration). I18nBoot then switches to the saved/browser language.
let current: Locale = "en";
let booted = false;
const listeners = new Set<() => void>();

export function getLocale(): Locale {
  return current;
}

function apply(l: Locale) {
  current = l;
  if (typeof document !== "undefined") document.documentElement.lang = LOCALE_META[l].htmlLang;
  listeners.forEach((fn) => fn());
}

export function setLocale(l: Locale): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* not remembered, but still switched for this session */
  }
  // Switch once the catalog is in; if it can't be fetched the app stays in the current language.
  return loadLocale(l).then(() => apply(l), () => undefined);
}

/** Mount once near the root: picks the saved (or browser) language after hydration. */
export function I18nBoot(): null {
  useEffect(() => {
    if (booted) return;
    booted = true;
    const l = initialLocale();
    if (l !== current) loadLocale(l).then(() => apply(l), () => undefined);
  }, []);
  return null;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-render on a language change. Call it in each root component (Page, HelperGate, the cloud viewer page):
 *  their subtrees re-render with them, so every `t()` below re-runs and no state is lost. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, () => "en" as Locale);
}

type Vars = Record<string, string | number>;

function lookup(key: string): string {
  const l = getLocale();
  if (l === "en") return key;
  const hit = loaded[l]?.[key];
  return typeof hit === "string" && hit !== "" ? hit : key;
}

function fill(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Translate a message. The key is the English text; `{name}` placeholders are filled from `vars`. */
export function t(key: string, vars?: Vars): string {
  return fill(lookup(key), vars);
}

/** Mark a string for extraction without translating it (module-level tables). Translate it with `t()` where shown. */
export function tx<S extends string>(key: S): S {
  return key;
}

/**
 * Translate a message with markup. `<name>text</name>` calls `parts.name(text)`; `{name}` is replaced by
 * `parts.name` when that is a node (or a string/number). Tags do not nest.
 */
export function tRich(key: string, parts: Record<string, ReactNode | ((inner: string) => ReactNode)>): ReactNode {
  const s = lookup(key);
  const out: ReactNode[] = [];
  const re = /<(\w+)>([\s\S]*?)<\/\1>|\{(\w+)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const name = m[1] ?? m[3];
    const p = parts[name];
    if (m[1] !== undefined) {
      // A {value} inside a tag ("<b>Try it on {name} first</b>") is filled with a plain string or number part.
      const inner = m[2].replace(/\{(\w+)\}/g, (all, k: string) => {
        const v = parts[k];
        return typeof v === "string" || typeof v === "number" ? String(v) : all;
      });
      out.push(typeof p === "function" ? p(inner) : inner);
    }
    else out.push(p === undefined ? m[0] : typeof p === "function" ? p("") : p);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.map((n, i) => createElement(Fragment, { key: i }, n));
}
