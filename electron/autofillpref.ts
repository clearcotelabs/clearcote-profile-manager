// Autofill on, as in Chrome. The engine's own defaults have "Save and fill addresses" and "Save and fill
// payment methods" off (autofill.profile_enabled / autofill.credit_card_enabled = false); Chrome 156 has
// both on. With addresses off, the browser also never remembers what was typed into single fields (emails,
// names), so a profile behaved unlike a real Chrome. Measured on r54 (10-30): rows in Default/Web Data
// `autofill` after a form submit — Chrome 2, r54 0, r54 with these prefs seeded 2.
//
// Only a missing key is set: a profile where someone turned autofill off keeps it off.

import fs from "node:fs";
import path from "node:path";

export const AUTOFILL_DEFAULTS = { profile_enabled: true, credit_card_enabled: true } as const;

/** Merge Chrome's autofill defaults into <userDataDir>/Default/Preferences where they are missing.
 *  Returns the keys it set. A Preferences file that cannot be parsed is left alone. */
export function seedAutofillPrefs(userDataDir: string): string[] {
  const dir = path.join(userDataDir, "Default");
  const file = path.join(dir, "Preferences");
  let prefs: Record<string, unknown> = {};
  try {
    prefs = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return []; // the browser's file, not ours to replace
  }
  const autofill = (prefs.autofill && typeof prefs.autofill === "object" ? prefs.autofill : {}) as Record<string, unknown>;
  const set = (Object.keys(AUTOFILL_DEFAULTS) as (keyof typeof AUTOFILL_DEFAULTS)[]).filter((k) => !(k in autofill));
  if (!set.length) return [];
  for (const k of set) autofill[k] = AUTOFILL_DEFAULTS[k];
  prefs.autofill = autofill;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(prefs), "utf8");
  return set;
}
