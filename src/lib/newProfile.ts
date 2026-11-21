// What a profile made with "New profile" starts with. Kept out of app/page.tsx so the defaults are
// testable: each one exists because a customer found the profile wrong without it.

import type { Platform, Profile } from "@/types/profile";

/** `platform` is the persona's OS: Windows unless the caller says otherwise — the app passes
 *  "macos" on a Mac (src/lib/host.ts defaultPersonaPlatform). */
export function newProfile(seed: string, now: string, platform: Platform = "windows"): Profile {
  return {
    id: "",
    name: "",
    fingerprint: seed,
    platform,
    // geoip ON. It only does anything once a proxy is set, and when one IS set, matching the
    // persona's timezone/language/position to the proxy's exit region is what everyone wants — the
    // off-by-default version shipped a profile that looked configured while the Geolocation API
    // quietly kept reporting the real position, which is exactly how a customer found it.
    geoip: true,
    // Widevine Auto (src/lib/widevineSetting.ts): on, as the Chrome brand needs (CR-KUDD3V), except on a
    // Windows/macOS host while the engine sends the licence request with a clear client id (builds before
    // r63), where the launcher holds it back and says so. Stored as "auto": a missing value means Off.
    widevine: "auto",
    createdAt: now,
    updatedAt: now,
  };
}
