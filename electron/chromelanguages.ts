// Copied from the clearcote SDK (sdk/node/src/languages.ts): the language lists genuine Chrome writes per interface language.
/**
 * Chrome's own language defaults, so a persona's languages look like a fresh Chrome profile.
 *
 * Genuine Chrome derives everything from ONE value, the OS locale: it resolves that to a UI locale
 * it ships (de-AT -> `de`, en-CA -> `en-GB`, es-MX -> `es-419`), then `navigator.languages` and the
 * Accept-Language header are that UI locale's built-in default list (`IDS_ACCEPT_LANGUAGES`) and
 * `Intl` uses the UI locale itself. Measured on Chrome 154 (Windows) for 67 OS locales; the lists
 * below are the 153 tree's `components/strings/components_locale_settings_<ui>.xtb` values and match
 * every measurement.
 *
 * Mirrors sdk/python/clearcote/_languages.py and sdk/dotnet/src/Clearcote/Languages.cs.
 */

/** Desktop Chrome's UI locales (the .pak set Google Chrome ships on Windows/Linux/macOS). */
export const CHROME_UI_LOCALES: ReadonlySet<string> = new Set([
  "af", "am", "ar", "bg", "bn", "ca", "cs", "da", "de", "el", "en-GB", "en-US", "es", "es-419",
  "et", "fa", "fi", "fil", "fr", "gu", "he", "hi", "hr", "hu", "id", "it", "ja", "kn", "ko", "lt",
  "lv", "ml", "mr", "ms", "nb", "nl", "pl", "pt-BR", "pt-PT", "ro", "ru", "sk", "sl", "sr", "sv",
  "sw", "ta", "te", "th", "tr", "uk", "ur", "vi", "zh-CN", "zh-TW",
]);

// IDS_ACCEPT_LANGUAGES per UI locale. A UI locale missing here (af, ms, ur, en-US) has no
// translation and uses the source default "en-US,en" -- e.g. Malay Chrome sends en-US,en.
const ACCEPT_LANGUAGES: Record<string, string> = {
  am: "am,en-GB,en", ar: "ar,en-US,en", bg: "bg-BG,bg", bn: "bn-IN,bn,en-US,en",
  ca: "ca-ES,ca", cs: "cs-CZ,cs", da: "da-DK,da,en-US,en", de: "de-DE,de,en-US,en",
  el: "el-GR,el", "en-GB": "en-GB,en-US,en", es: "es-ES,es", "es-419": "es-419,es",
  et: "et-EE,et,en-US,en", fa: "fa,en-US,en", fi: "fi-FI,fi,en-US,en",
  fil: "fil,fil-PH,tl,en-US,en", fr: "fr-FR,fr,en-US,en", gu: "gu-IN,gu,hi-IN,hi,en-US,en",
  he: "he-IL,he,en-US,en", hi: "hi-IN,hi,en-US,en", hr: "hr-HR,hr,en-US,en",
  hu: "hu-HU,hu,en-US,en", id: "id-ID,id,en-US,en", it: "it-IT,it,en-US,en",
  ja: "ja,en-US,en", kn: "kn-IN,kn,en-US,en", ko: "ko-KR,ko,en-US,en",
  lt: "lt,en-US,en,ru,pl", lv: "lv-LV,lv,en-US,en", ml: "ml-IN,ml,en-US,en",
  mr: "mr-IN,mr,hi-IN,hi,en-US,en", nb: "nb-NO,nb,no,nn,en-US,en", nl: "nl-NL,nl,en-US,en",
  pl: "pl-PL,pl,en-US,en", "pt-BR": "pt-BR,pt,en-US,en", "pt-PT": "pt-PT,pt,en-US,en",
  ro: "ro-RO,ro,en-US,en", ru: "ru-RU,ru,en-US,en", sk: "sk-SK,sk,cs,en-US,en",
  sl: "sl-SI,sl,en-GB,en", sr: "sr-RS,sr,en-US,en", sv: "sv-SE,sv,en-US,en",
  sw: "sw,en-GB,en", ta: "ta-IN,ta,en-US,en", te: "te-IN,te,hi-IN,hi,en-US,en",
  th: "th-TH,th", tr: "tr-TR,tr,en-US,en", uk: "uk-UA,uk,en-US,en",
  vi: "vi-VN,vi,fr-FR,fr,en-US,en", "zh-CN": "zh-CN,zh", "zh-TW": "zh-TW,zh,en-US,en",
};

// Legacy / macro codes Chrome's matcher folds into a shipped locale.
const LANGUAGE_ALIASES: Record<string, string> = { iw: "he", in: "id", tl: "fil", no: "nb", nn: "nb" };
// English regions Chrome resolves to en-US (en-PH measured); every other region gets en-GB
// (en-CA/AU/NZ/IE/IN/ZA/SG measured).
const EN_US_REGIONS = new Set(["", "US", "PH", "AS", "GU", "MH", "MP", "PR", "UM", "VI"]);
// Spanish regions that stay "es"; the rest of the Spanish-speaking world gets es-419 (es-MX/AR/CL/
// CO/US measured).
const ES_ES_REGIONS = new Set(["", "ES", "EA", "IC", "GQ"]);

function splitTag(tag: string): [lang: string, script: string, region: string] {
  const parts = String(tag).trim().split(/[-_]/).filter((p) => p);
  if (parts.length === 0) return ["", "", ""];
  let script = "";
  let region = "";
  for (const part of parts.slice(1)) {
    if (/^[A-Za-z]{4}$/.test(part)) script = part[0].toUpperCase() + part.slice(1).toLowerCase();
    else if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) region = part.toUpperCase();
  }
  const lang = parts[0].toLowerCase();
  return [LANGUAGE_ALIASES[lang] ?? lang, script, region];
}

/**
 * The UI locale Chrome picks for an OS locale `tag` (`de-AT` -> `de`), or undefined when Chrome
 * ships no UI in that language (it would fall back to the OS's other languages / en-US).
 */
export function chromeUiLocale(tag: string): string | undefined {
  const [lang, script, region] = splitTag(tag);
  if (!lang) return undefined;
  if (lang === "en") return EN_US_REGIONS.has(region) ? "en-US" : "en-GB";
  if (lang === "es") return ES_ES_REGIONS.has(region) ? "es" : "es-419";
  if (lang === "pt") return region === "" || region === "BR" ? "pt-BR" : "pt-PT";
  if (lang === "zh") {
    const traditional = script === "Hant" || (script !== "Hans" && ["TW", "HK", "MO"].includes(region));
    return traditional ? "zh-TW" : "zh-CN";
  }
  return CHROME_UI_LOCALES.has(lang) ? lang : undefined;
}

/** Chrome's default navigator.languages for a UI locale, as a comma list (`de` -> `de-DE,de,en-US,en`). */
export function chromeAcceptLanguages(uiLocale: string): string {
  return ACCEPT_LANGUAGES[uiLocale] ?? "en-US,en";
}

/**
 * Map a cleaned Accept-Language value to `[acceptLang, langSwitch]` for the engine.
 *
 * - ONE tag (`de-AT`) is read as the OS locale: the result is exactly what a fresh Chrome profile on
 *   that OS shows -- `["de-DE,de,en-US,en", "de"]`.
 * - A LIST (`de-AT,de,en`) is the caller's own language list and is kept verbatim; only the UI locale
 *   (`--lang`, which drives Intl and the browser UI) is resolved from its first tag.
 * - A tag Chrome has no UI for (`is-IS`) is passed through unchanged, as before.
 */
export function resolveLanguages(clean: string): [acceptLang: string, langSwitch: string | undefined] {
  const tags = clean.split(",").filter((t) => t);
  if (tags.length === 0) return [clean, undefined];
  const ui = chromeUiLocale(tags[0]);
  if (tags.length === 1 && ui) return [chromeAcceptLanguages(ui), ui];
  return [clean, ui ?? tags[0]];
}
