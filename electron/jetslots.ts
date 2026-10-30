// The {{slots}} of a task goal and the values a profile fills them with. Pure, so the run-a-task dialog
// (renderer) shows exactly what the run (main process) will send.
//
// A goal is a template: "Log in as {{email}} and set the display name to {{name}}". Every profile fills
// it from its own values, and Jet keys the learned skill on the template, so the task is learned once
// and replayed on the rest. Built-in values: name, id, group, tags. The rest come from the profile's
// task values (Profile.vars). A secret value is sent to Jet as a secret: Jet keeps `{{slot}}` in what
// its model sees and types the value only, and it is masked in everything the app shows.

import type { Profile } from "./types";

const SLOT = /\{\{\s*([A-Za-z_][\w.-]{0,63})\s*\}\}/g;
export const BUILTIN_SLOTS = ["name", "id", "group", "tags"] as const;

/** The distinct slot names in a goal, in order of first use. */
export function templateSlots(goal: string): string[] {
  const seen: string[] = [];
  for (const m of goal.matchAll(SLOT)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}

/** A goal's slots written the one way Jet keys skills on: `{{ email }}` and `{{email}}` are one task. */
export function normalizeTemplate(goal: string): string {
  return goal.trim().replace(SLOT, (_m, k: string) => `{{${k}}}`);
}

export interface SlotValues {
  values: Record<string, string>;
  secret: string[];
}

/** Everything a profile can fill a slot with. A var named like a built-in wins over it. */
export function profileValues(p: Pick<Profile, "id" | "name" | "group" | "tags" | "vars">): SlotValues {
  const values: Record<string, string> = { name: p.name, id: p.id };
  if (p.group) values.group = p.group;
  if (p.tags?.length) values.tags = p.tags.join(", ");
  const secret: string[] = [];
  for (const v of p.vars ?? []) {
    const key = v.key.trim();
    if (!/^[A-Za-z_][\w.-]{0,63}$/.test(key)) continue;
    values[key] = v.value;
    if (v.secret) secret.push(key);
  }
  return { values, secret };
}

/** The values one profile sends for this goal: only the slots it uses, with the empty ones listed as missing. */
export function valuesFor(goal: string, p: Pick<Profile, "id" | "name" | "group" | "tags" | "vars">) {
  const all = profileValues(p);
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const slot of templateSlots(goal)) {
    const v = all.values[slot];
    if (v === undefined || v === "") missing.push(slot);
    else values[slot] = v;
  }
  return { values, secret: all.secret.filter((k) => k in values), missing };
}

const SECRET_WORDS = new Set(["pass", "password", "passwd", "passphrase", "pwd", "pw", "secret", "token", "pin", "otp", "totp", "key", "apikey", "cvv", "cvc"]);

/** A slot name that looks like a secret, word by word: password, api_key, otpCode; not zipcode or passport. */
export function looksSecret(name: string): boolean {
  return name
    .split(/[_.\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .some((w) => SECRET_WORDS.has(w.toLowerCase()));
}

/** `text` with every secret value replaced by its slot, for anything shown or kept. */
export function maskSecrets(text: string, values: Record<string, string>, secret: string[]): string {
  // Each value as typed and as a URL or a form would carry it ("p@ss w" -> "p%40ss%20w", "p%40ss+w"), longest
  // first, so a secret that contains another is masked whole.
  const forms: [string, string][] = [];
  for (const k of secret) {
    const v = values[k];
    if (!v) continue;
    const enc = encodeURIComponent(v);
    for (const f of new Set([v, enc, enc.replace(/%20/g, "+")])) forms.push([f, k]);
  }
  forms.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [f, k] of forms) out = out.split(f).join(`{{${k}}}`);
  return out;
}
