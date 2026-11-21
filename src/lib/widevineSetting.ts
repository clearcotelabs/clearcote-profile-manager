// Widevine Auto / On / Off, for the renderer (coherence, the editor). Mirror of widevineSetting in
// electron/widevine.ts, which the renderer cannot import; tests/widevineSetting.test.ts keeps the two equal.

export type WidevineSetting = "auto" | "on" | "off";

/** "auto" and the old checkbox's `true` are Auto (every new profile got `true` by default, so it says nothing
 *  about a choice); "on" always seeds; "off", and anything else, never does. The old checkbox stored NOTHING
 *  when unticked, so a missing value stays Off, as it always was. */
export function widevineSetting(v: unknown): WidevineSetting {
  if (v === "on") return "on";
  if (v === "auto" || v === true) return "auto";
  return "off";
}

/** First engine revision whose CDM host encrypts the client id in its licence request (pro-r63-05). */
export const MIN_REVISION_CDM_HOST_VERIFICATION = 63;

/** Whether Auto holds Widevine back for this launch, judged from what the renderer knows: a Windows or
 *  macOS host and a build known to predate r63 (the open build, or a PRO revision below 63). Unknown
 *  (an explicit binary, an unresolved catalog) answers undefined: the launcher reads the binary itself. */
export function autoHeldBack(ctx: { hostPlatform?: string; revision?: number; tier?: string }): boolean | undefined {
  if (ctx.hostPlatform === "linux") return false;
  if (ctx.hostPlatform !== "windows" && ctx.hostPlatform !== "macos") return undefined;
  if (ctx.tier === "free") return true;
  if (ctx.revision === undefined) return undefined;
  return ctx.revision < MIN_REVISION_CDM_HOST_VERIFICATION;
}
