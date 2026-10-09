// What a profile made with "New profile" starts with. Kept out of app/page.tsx so the defaults are
// testable: each one exists because a customer found the profile wrong without it.

import type { Profile } from "@/types/profile";

export function newProfile(seed: string, now: string): Profile {
  return {
    id: "",
    name: "",
    fingerprint: seed,
    platform: "windows",
    // geoip ON. It only does anything once a proxy is set, and when one IS set, matching the
    // persona's timezone/language/position to the proxy's exit region is what everyone wants — the
    // off-by-default version shipped a profile that looked configured while the Geolocation API
    // quietly kept reporting the real position, which is exactly how a customer found it.
    geoip: true,
    // Widevine ON. Every profile claims the Google Chrome brand unless changed, and Google's build
    // always ships the CDM, so without it a fresh profile opened with a coherence error
    // (CR-KUDD3V). The CDM is fetched once and shared; a failed fetch only warns at launch.
    widevine: true,
    createdAt: now,
    updatedAt: now,
  };
}
