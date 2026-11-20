// The Accept-Language list a geoip launch gives a country is the list genuine Chrome writes for that
// country's interface language (measured on Chrome 157, Windows, fresh profile, --lang=<locale>).
// The table used to hold lists no Chrome install has: fi-FI,fi,en and de-DE,de (CR-LYJSFW 2026-11-20).
import { describe, expect, it } from "vitest";
import { languageForCountry } from "../electron/geo";
import { cleanAcceptLanguage, defaultTimezone } from "../electron/fpargs";

// navigator.languages of genuine Chrome 157 per interface language.
const CHROME: Record<string, string> = {
  "en-US": "en-US,en", "en-GB": "en-GB,en-US,en", de: "de-DE,de,en-US,en", fr: "fr-FR,fr,en-US,en",
  nl: "nl-NL,nl,en-US,en", es: "es-ES,es", "es-419": "es-419,es", it: "it-IT,it,en-US,en",
  "pt-PT": "pt-PT,pt,en-US,en", "pt-BR": "pt-BR,pt,en-US,en", ru: "ru-RU,ru,en-US,en", uk: "uk-UA,uk,en-US,en",
  pl: "pl-PL,pl,en-US,en", sv: "sv-SE,sv,en-US,en", nb: "nb-NO,nb,no,nn,en-US,en", da: "da-DK,da,en-US,en",
  fi: "fi-FI,fi,en-US,en", hr: "hr-HR,hr,en-US,en", ja: "ja,en-US,en", ko: "ko-KR,ko,en-US,en",
  "zh-CN": "zh-CN,zh", "zh-TW": "zh-TW,zh,en-US,en", tr: "tr-TR,tr,en-US,en", id: "id-ID,id,en-US,en",
  th: "th-TH,th", vi: "vi-VN,vi,fr-FR,fr,en-US,en",
};
// The interface language Chrome runs in for each country in the table.
const COUNTRY: Record<string, string> = {
  US: "en-US", GB: "en-GB", IE: "en-GB", CA: "en-GB", AU: "en-GB", NZ: "en-GB", IN: "en-GB", SG: "en-GB",
  DE: "de", AT: "de", CH: "de", FR: "fr", BE: "nl", NL: "nl", ES: "es", MX: "es-419", AR: "es-419", IT: "it",
  PT: "pt-PT", BR: "pt-BR", RU: "ru", UA: "uk", PL: "pl", SE: "sv", NO: "nb", DK: "da", FI: "fi", HR: "hr",
  JP: "ja", KR: "ko", CN: "zh-CN", TW: "zh-TW", HK: "zh-TW", TR: "tr", ID: "id", TH: "th", VN: "vi",
};

describe("geoip Accept-Language per country", () => {
  it("is Chrome's own list for every country in the table", () => {
    for (const [cc, ui] of Object.entries(COUNTRY)) expect(languageForCountry(cc), cc).toBe(CHROME[ui]);
  });

  it("no longer holds the lists no Chrome install has", () => {
    expect(languageForCountry("FI")).toBe("fi-FI,fi,en-US,en");
    expect(languageForCountry("DE")).toBe("de-DE,de,en-US,en");
    expect(languageForCountry("NL")).toBe("nl-NL,nl,en-US,en");
    expect(languageForCountry("JP")).toBe("ja,en-US,en");
    const all = Object.keys(COUNTRY).map((cc) => languageForCountry(cc));
    for (const list of all) {
      const tags = list.split(",");
      expect(tags.at(-1) === "en" ? tags.at(-2) : "en-US", list).toBe("en-US"); // a bare "en" only after en-US
    }
  });

  it("is case-insensitive and falls back to en-US,en", () => {
    expect(languageForCountry("fi")).toBe("fi-FI,fi,en-US,en");
    expect(languageForCountry("ZZ")).toBe("en-US,en");
    expect(languageForCountry(undefined)).toBe("en-US,en");
  });

  it("every list survives the switch builder unchanged and its first tag has a timezone fallback", () => {
    for (const cc of Object.keys(COUNTRY)) {
      const list = languageForCountry(cc);
      expect(cleanAcceptLanguage(list)).toBe(list);
      expect(defaultTimezone(list.split(",")[0]), cc).toBeTruthy();
    }
    expect(defaultTimezone("ja")).toBe("Asia/Tokyo");
  });
});
