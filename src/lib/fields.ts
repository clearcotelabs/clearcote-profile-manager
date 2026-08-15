// The profile editor's field schema — the single list of every editable setting, its category, and
// how it is presented.
//
// WHY A SCHEMA. The editor used to be one flat run of JSX: ~35 controls plus nine paragraphs of
// help, in one scroll, with an "Advanced stealth" section that had become a dumping ground. Every
// engine release appended more to it (r13–r15 added four switches). Describing the fields as data
// instead means a new switch is one entry with a category, the search box is a filter over this
// list, and the coherence rules (src/lib/coherence.ts) can point at a field by key and have the UI
// navigate to it.
//
// PURE: no React, no `node:` imports, no Electron. The renderer imports it, and so can tests.
//
// A handful of settings are not plain inputs — the captured-fingerprint picker, the runtime-
// populated version dropdown, the proxy row with its geo-resolve button. Those declare
// `custom: <id>` and the editor renders a bespoke control for them; they still live here so they
// keep their category, their search text and their position.

export type CategoryId = "identity" | "browser" | "hardware" | "network" | "rendering" | "session";

export interface Category {
  id: CategoryId;
  /** Rail label. Kept to one word so the rail stays narrow. */
  label: string;
  /** Panel heading, which may be fuller than the rail label. */
  title: string;
  /** One line under the heading: the question this category answers. */
  blurb: string;
}

/** Grouped by the question the user is answering, not by which switch the value maps to. */
export const CATEGORIES: Category[] = [
  {
    id: "identity",
    label: "Identity",
    title: "Identity",
    blurb:
      "Who this profile is. The seed drives a coherent persona; a captured fingerprint replaces it with a real machine's values.",
  },
  {
    id: "browser",
    label: "Browser",
    title: "Browser",
    blurb: "Which build to launch, and what it claims to be.",
  },
  {
    id: "hardware",
    label: "Hardware",
    title: "Hardware",
    blurb: "The machine the persona claims. An explicit value beats the persona, which beats the real one.",
  },
  {
    id: "network",
    label: "Network",
    title: "Network & locale",
    blurb: "Where traffic exits, and everything that should agree with it.",
  },
  {
    id: "rendering",
    label: "Rendering",
    title: "Rendering",
    blurb: "What canvas, WebGL and audio report.",
  },
  {
    id: "session",
    label: "Session",
    title: "Session & data",
    blurb: "What survives a restart, and what moves between machines.",
  },
];

export type FieldType = "text" | "textarea" | "number" | "password" | "select" | "check" | "custom";

export interface FieldDef {
  /** Profile key this binds to. Also the id coherence issues use to point here. */
  key: string;
  cat: CategoryId;
  label: string;
  type: FieldType;
  /** Span the full panel width rather than one grid column. */
  full?: boolean;
  /** Render the value in the mono face (seeds, proxies, paths, raw flags). */
  mono?: boolean;
  placeholder?: string;
  /** Static options. A runtime-populated dropdown uses `custom` instead. */
  options?: { value: string; label: string }[];
  /** For checkboxes: the sentence beside the label. */
  desc?: string;
  /** Always-visible one-liner under the control. Keep it to a line — anything longer belongs in
   *  `why`, which is behind the ? and costs no vertical space. */
  hint?: string;
  /** The "why does this exist" note, shown on the ? affordance. This is where the paragraphs that
   *  used to sit permanently between fields now live. */
  why?: string;
  /** Checkbox whose absence means ON (only `fingerprintNoise` today). Affects both the rendered
   *  state and whether the field counts as "set" — see isFieldSet. */
  defaultOn?: boolean;
  /** Fields sharing a group render inside one bordered sub-panel with this heading. Used to keep
   *  the riskier clusters visually separate from the routine ones — screen dimensions inside
   *  Hardware, the canvas bridge inside Rendering — rather than letting them read as equally
   *  ordinary. Group members must be contiguous in this array. */
  group?: string;
  /** One line under the group heading, on the first member only. */
  groupNote?: string;
  /** `step="any"` on a number input, for the metadata overrides that accept fractions
   *  (a pixel ratio of 1.25 is real; a screen width of 1920.5 is not). */
  stepAny?: boolean;
  /** Disable this field while the named boolean key is truthy — the app already does this for the
   *  GPU strings under "use real GPU" and the portable toggle under an explicit key. */
  disabledBy?: string;
  /** Only render when this predicate passes. Keeps the canvas-bridge sub-options hidden until a
   *  bridge URL exists, exactly as before. */
  showWhen?: (p: Record<string, unknown>) => boolean;
  /** Bespoke control id, for the settings that are not plain inputs. */
  custom?:
    | "fingerprintProfile"
    | "browserVersion"
    | "proxy"
    | "seed"
    | "tags"
    | "extraArgs"
    | "canvasBridgeAllow"
    | "canvasBridgeDeny";
  /** Extra words the search box should match (synonyms, switch names). */
  keywords?: string;
  /** Select option whose value means "unset" and is stored as undefined, so a profile keeps only
   *  what was actually chosen. `platform` has none — it always stores its literal. */
  defaultOption?: string;
  /** What a checkbox stores when on / off. The default is true / undefined, which keeps saved JSON
   *  free of `false` noise. Two fields deliberately store a real `false` (geoip, and farbling noise,
   *  where `false` is the meaningful state), and the shader dialect stores a string union. */
  onValue?: unknown;
  offValue?: unknown;
}

export const FIELDS: FieldDef[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { key: "name", cat: "identity", label: "Name", type: "text", full: true, placeholder: "e.g. Acme — US East" },
  {
    key: "fingerprint",
    cat: "identity",
    label: "Fingerprint seed",
    type: "custom",
    custom: "seed",
    full: true,
    mono: true,
    keywords: "--fingerprint persona random",
    why: "Drives the whole persona. The same seed always produces the same identity, so keep it to keep the identity.",
  },
  {
    key: "fingerprintProfile",
    cat: "identity",
    label: "Captured fingerprint",
    type: "custom",
    custom: "fingerprintProfile",
    full: true,
    keywords: "--fingerprint-profile library import real machine gpu",
    why:
      "Adopts a real machine's GPU, screen, fonts, voices and WebGL. Its fields override the seed persona; anything it does not carry falls back to the seed. Strongest coherence comes from a capture whose GPU vendor matches this host.",
  },
  { key: "tags", cat: "identity", label: "Tags", type: "custom", custom: "tags", placeholder: "us, social" },
  { key: "group", cat: "identity", label: "Group", type: "text", placeholder: "optional" },
  { key: "notes", cat: "identity", label: "Notes", type: "textarea", full: true, placeholder: "anything worth remembering" },

  // ── Browser ───────────────────────────────────────────────────────────────
  {
    key: "browserVersion",
    cat: "browser",
    label: "Browser version",
    type: "custom",
    custom: "browserVersion",
    keywords: "pro free 151 150 149 revision r15 pin",
    why:
      "Latest is the newest of your tier. A Pro build needs a licence key in Settings. Latest and a bare major both follow the current Pro pin, which moves when a rebuild ships — pin a revision for a reproducible run.",
  },
  {
    key: "platform",
    cat: "browser",
    label: "Platform",
    type: "select",
    options: [
      { value: "windows", label: "windows" },
      { value: "linux", label: "linux" },
      { value: "macos", label: "macos" },
      { value: "android", label: "android — mobile persona" },
    ],
    hint: "Defaults to this host.",
    keywords: "--fingerprint-platform mobile",
    why:
      "Android is a best-effort phone identity: mobile UA and UA-CH, touch, a phone viewport, portrait orientation, no PDF plugin and a Mali/Adreno GPU.",
  },
  { key: "platformVersion", cat: "browser", label: "Platform version", type: "text", placeholder: "15.0.0", keywords: "--fingerprint-platform-version ua-ch" },
  {
    defaultOption: "",
    key: "brand",
    cat: "browser",
    label: "Brand",
    type: "select",
    options: [
      // Unset is the launcher's own default, which is Chrome — offered explicitly so choosing it
      // stores nothing rather than pinning a value the default would have supplied anyway.
      { value: "", label: "(default — Chrome)" },
      { value: "Chrome", label: "Chrome" },
      { value: "Edge", label: "Edge" },
      { value: "Opera", label: "Opera" },
      { value: "Vivaldi", label: "Vivaldi" },
      { value: "Chromium", label: "Chromium" },
    ],
    keywords: "--fingerprint-brand ua-ch google",
    why:
      "Claiming Google Chrome commits the build to everything Google's ships — including the Widevine CDM. Chromium is what a de-Googled build honestly is, and is held to less.",
  },
  { key: "brandVersion", cat: "browser", label: "Brand version", type: "text", placeholder: "151.0.0.0", keywords: "--fingerprint-brand-version" },
  {
    defaultOption: "",
    key: "tlsProfile",
    cat: "browser",
    label: "TLS profile",
    type: "select",
    options: [
      { value: "", label: "match persona (default)" },
      { value: "native", label: "native — the build's own TLS" },
      { value: "chrome-151", label: "chrome-151" },
      { value: "chrome-150", label: "chrome-150" },
      { value: "chrome-149", label: "chrome-149" },
    ],
    keywords: "--fingerprint-tls-profile clienthello ja3",
    why:
      "Keeps the TLS ClientHello coherent with the Chrome version the persona claims, instead of always emitting the build's native one.",
  },

  // ── Hardware ──────────────────────────────────────────────────────────────
  {
    key: "lightStealth",
    cat: "hardware",
    label: "Light stealth",
    type: "check",
    desc: "Spoof only the metadata axes that survive strict checks, through the native switches — no persona, no farbling.",
    hint: "Rendering, TLS and the real Chrome version are left untouched. Screen is deliberately not spoofed.",
    keywords: "preset narrow surface",
    why:
      "Not strictly better than the default: it trades a broad persona for a much narrower surface. In our own lab runs it scored worse on an audit suite. Test it against your target.",
  },
  { key: "hardwareConcurrency", cat: "hardware", label: "CPU cores", type: "number", placeholder: "persona default", keywords: "--fingerprint-hardware-concurrency navigator" },
  {
    key: "deviceMemory",
    cat: "hardware",
    label: "Memory (GB)",
    type: "select",
    defaultOption: "",
    // A CLOSED set, not a free number. Chromium reports RAM rounded to the nearest power of two and
    // then clamped — desktop to [2, 32], Android to [1, 8] (see
    // third_party/blink/common/device_memory/approximated_device_memory.cc, limits updated in
    // crbug.com/454354290; the old 8 GB ceiling everyone remembers is long gone). The engine's
    // persona path quantizes to a power of two but does NOT apply the clamp, so a value outside the
    // range passes straight through to the page — measured: 16 arrives as 16. Offering a text box
    // invited a 64 that no browser can report, so the choice is constrained here instead.
    options: [
      { value: "", label: "(persona default)" },
      { value: "1", label: "1 — Android only" },
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "8", label: "8" },
      { value: "16", label: "16" },
      { value: "32", label: "32 — desktop maximum" },
    ],
    keywords: "--fingerprint-device-memory navigator devicememory ram",
    why:
      "navigator.deviceMemory, reported as a power of two. Desktop Chromium clamps it to 2–32 and Android to 1–8, so a machine with 64 GB still reports 32.",
  },
  {
    key: "screenWidth",
    cat: "hardware",
    label: "Screen width",
    type: "number",
    placeholder: "real",
    group: "Screen dimensions",
    groupNote:
      "The risky row. A faked screen cannot be reconciled with the real window and render surface, so set these only when they match this host's display — or leave them to a captured profile.",
    keywords: "--fingerprint-screen-width display",
    why:
      "Spoofing screen dimensions is a reliable block trigger: a faked screen cannot be reconciled with the real window and render surface. Set it only when it matches this host's actual display.",
  },
  { group: "Screen dimensions", key: "screenHeight", cat: "hardware", label: "Screen height", type: "number", placeholder: "real", keywords: "--fingerprint-screen-height display" },
  { group: "Screen dimensions", key: "availWidth", cat: "hardware", label: "Avail width", type: "number", placeholder: "real", keywords: "--fingerprint-avail-width taskbar" },
  { group: "Screen dimensions", key: "availHeight", cat: "hardware", label: "Avail height", type: "number", placeholder: "real", keywords: "--fingerprint-avail-height taskbar" },
  { stepAny: true, key: "colorDepth", cat: "hardware", label: "Colour depth", type: "number", placeholder: "24", keywords: "--fingerprint-color-depth" },
  { stepAny: true, key: "devicePixelRatio", cat: "hardware", label: "Pixel ratio", type: "number", placeholder: "1", keywords: "--fingerprint-device-pixel-ratio dpr scaling" },
  { stepAny: true, key: "maxTouchPoints", cat: "hardware", label: "Touch points", type: "number", placeholder: "0", keywords: "--fingerprint-max-touch-points touchscreen", why: "0 is a real value — a mouse-only desktop — not an empty one." },
  { disabledBy: "disableGpuFingerprint", key: "gpuVendor", cat: "hardware", label: "GPU vendor", type: "text", placeholder: "persona default", keywords: "--fingerprint-gpu-vendor webgl unmasked" },
  { disabledBy: "disableGpuFingerprint", key: "gpuRenderer", cat: "hardware", label: "GPU renderer", type: "text", placeholder: "persona default", keywords: "--fingerprint-gpu-renderer webgl angle unmasked" },
  {
    key: "storageQuota",
    cat: "hardware",
    label: "Storage quota (MB)",
    type: "number",
    placeholder: "e.g. 250000",
    keywords: "--fingerprint-storage-quota navigator.storage estimate",
    why: "navigator.storage.estimate().quota. A tiny value reads as incognito or a throwaway test machine.",
  },

  // ── Network ───────────────────────────────────────────────────────────────
  {
    key: "proxy",
    cat: "network",
    label: "Proxy",
    type: "custom",
    custom: "proxy",
    full: true,
    mono: true,
    keywords: "socks5 http https credentials relay egress",
    why:
      "One string, credentials inline. An authenticated http/https proxy is served through a local auth-injecting relay, so the browser never prompts. An authenticated socks5 proxy is authenticated by the engine itself (RFC 1929), which stock Chromium cannot do at all — it needs build 151.",
  },
  {
    onValue: true,
    offValue: false,
    key: "geoip",
    cat: "network",
    label: "geoip",
    type: "check",
    desc: "At launch, fill any unset timezone, language, geolocation and WebRTC IP from the proxy's exit region.",
    hint: "Values you set yourself always win.",
    keywords: "auto match exit region",
    why:
      "Without this, and without a geolocation set, the Geolocation API reports the host's real position — the proxy alone does not move it.",
  },
  { key: "timezone", cat: "network", label: "Timezone", type: "text", placeholder: "America/New_York", keywords: "--timezone iana", why: "Unset, a timezone coherent with the locale is derived, rather than leaking the host's (often UTC on a server)." },
  { key: "acceptLanguage", cat: "network", label: "Accept-Language", type: "text", placeholder: "en-US,en", keywords: "--accept-lang navigator.languages locale" },
  {
    key: "location",
    cat: "network",
    label: "Geolocation",
    type: "text",
    placeholder: "lat,lng",
    keywords: "--fingerprint-location gps coordinates position",
    why: "What the Geolocation API reports, once a page has permission. Unset and with geoip off, that is your real position.",
  },
  { key: "webrtcIp", cat: "network", label: "WebRTC IP", type: "text", placeholder: "proxy egress IP", keywords: "--webrtc-ip srflx stun leak" },
  {
    defaultOption: "on",
    key: "webrtcMdns",
    cat: "network",
    label: "WebRTC mDNS",
    type: "select",
    options: [
      { value: "on", label: "on — hide local IPs (default)" },
      { value: "off", label: "off — expose the LAN IP" },
    ],
    keywords: "mdns local candidates lan",
    why:
      "Real Chrome hides local host candidates behind a .local name, and so does this by default. Switching it off re-exposes your private IP to every page.",
  },

  // ── Rendering ─────────────────────────────────────────────────────────────
  {
    onValue: true,
    offValue: false,
    key: "fingerprintNoise",
    cat: "rendering",
    label: "Farbling noise",
    type: "check",
    defaultOn: true,
    desc: "Per-site noise on canvas, WebGL, audio and client rects. On by default.",
    hint: "Turn it off for natural, unperturbed surfaces — best paired with a captured profile.",
    keywords: "--disable-fingerprint-noise farble canvas audio",
    why: "Identity spoofs (UA, screen, GPU, persona) stay on either way; this only affects the noised surfaces.",
  },
  {
    key: "disableGpuFingerprint",
    cat: "rendering",
    label: "Use real GPU",
    type: "check",
    desc: "Report this host's actual GPU and WebGL instead of a spoofed one.",
    keywords: "--disable-gpu-fingerprint webgl real",
    why: "The most coherent option when no captured profile matches the host's real render.",
  },
  // The two NARROW halves of the switches above, for when the broad one costs more coherence than
  // it buys. Both read as "on by default, and only meaningful when switched off".
  {
    key: "gpuStringSpoof",
    cat: "rendering",
    label: "Real GPU strings only",
    type: "check",
    defaultOn: true,
    onValue: true,
    offValue: false,
    desc: "Report the real WebGL vendor and renderer, while the limits, extensions and readback stay on the persona.",
    hint: "The narrow half of “use real GPU”. Needs 150 r12 or newer.",
    keywords: "--disable-gpu-string-spoof unmasked vendor renderer software rasterise swiftshader",
    why:
      "For a host that rasterises in software, where a spoofed GPU string cannot be backed by the render. navigator.gpu still follows the wide switch, so WebGPU keeps describing the persona.",
  },
  {
    key: "canvasNoise",
    cat: "rendering",
    label: "Canvas 2D noise",
    type: "check",
    defaultOn: true,
    onValue: true,
    offValue: false,
    desc: "Per-site farble on 2D canvas readback. On by default.",
    hint: "Turning this off leaves WebGL and audio noised — narrower than switching farbling off entirely. Needs 150 r12 or newer.",
    keywords: "--disable-canvas-noise getImageData toDataURL farble 2d",
    why:
      "Some sites hash a 2D canvas and reject anything perturbed, while still wanting the other surfaces noised. This unfarbles that one surface rather than the whole process.",
  },
  {
    onValue: "hlsl",
    key: "shaderDialect",
    cat: "rendering",
    label: "HLSL shader dialect",
    type: "check",
    desc: "Re-translate shaders to HLSL for a Windows persona running on a Linux host.",
    hint: "No effect on a Windows host. Needs build 151.",
    keywords: "CLEARCOTE_SHADER_DIALECT angle spirv vulkan d3d11 getTranslatedShaderSource",
    why:
      "A Windows persona claims a Direct3D11 renderer, but on Linux the Vulkan backend answers with SPIR-V, and the two contradict each other. Off by default: the re-translation is a different code path from the one that drew, so a shader it cannot translate falls back to the honest answer.",
  },
  {
    key: "canvasBridgeUrl",
    cat: "rendering",
    group: "Canvas bridge",
    groupNote: "Experimental — needs a bridge host and a build with bridge support. Forces --no-sandbox.",
    label: "Canvas bridge URL",
    type: "text",
    full: true,
    mono: true,
    placeholder: "ws://host:port/path",
    keywords: "--canvas-bridge-url remote gpu readback experimental",
    why:
      "Forwards canvas and WebGL readback to a remote real-GPU host, so pixel hashes match the claimed GPU. Needs a bridge host and a build with bridge support, and forces --no-sandbox.",
  },
  { group: "Canvas bridge", showWhen: (p) => !!p.canvasBridgeUrl, key: "canvasBridgeAuth", cat: "rendering", label: "Bridge credentials", type: "password", placeholder: "user:secret", keywords: "--canvas-bridge-auth basic" },
  {
    group: "Canvas bridge",
    showWhen: (p) => !!p.canvasBridgeUrl,
    defaultOption: "",
    key: "canvasBridgeMode",
    cat: "rendering",
    label: "Origin policy",
    type: "select",
    options: [
      { value: "", label: "unset" },
      { value: "off", label: "off" },
      { value: "all", label: "all — bridge everything" },
      { value: "allow", label: "allow list" },
      { value: "deny", label: "deny list" },
    ],
    keywords: "--canvas-bridge-mode per-origin",
    why:
      "Every bridged readback is a network round-trip on the renderer thread, which is itself a timing signal. Restrict bridging to the origins that actually score canvas coherence.",
  },
  { group: "Canvas bridge", showWhen: (p) => !!p.canvasBridgeUrl && p.canvasBridgeMode === "allow", key: "canvasBridgeAllow", cat: "rendering", label: "Allow list", type: "custom", custom: "canvasBridgeAllow", placeholder: "example.com, other.com", keywords: "--canvas-bridge-allow" },
  { group: "Canvas bridge", showWhen: (p) => !!p.canvasBridgeUrl && p.canvasBridgeMode === "deny", key: "canvasBridgeDeny", cat: "rendering", label: "Deny list", type: "custom", custom: "canvasBridgeDeny", placeholder: "example.com", keywords: "--canvas-bridge-deny" },
  {
    group: "Canvas bridge",
    showWhen: (p) => !!p.canvasBridgeUrl,
    defaultOption: "",
    key: "canvasBridgeFallback",
    cat: "rendering",
    label: "Cache miss",
    type: "select",
    options: [
      { value: "", label: "unset" },
      { value: "block", label: "block — wait for the bridge (default)" },
      { value: "local", label: "local — never stall, render here" },
    ],
    keywords: "--canvas-bridge-fallback cold",
  },

  // ── Session ───────────────────────────────────────────────────────────────
  {
    key: "widevine",
    cat: "session",
    label: "Widevine (DRM)",
    type: "check",
    desc: "Fetch Google's Widevine CDM and seed it into this profile, so DRM video plays and the Chrome brand holds up.",
    hint: "Downloaded once from Google's own component server, SHA-256 verified, then shared by every profile that opts in.",
    keywords: "eme drm cdm com.widevine.alpha media keys",
    why:
      "This build compiles the EME plumbing but cannot bundle Google's proprietary CDM. A browser claiming the Google Chrome brand and then rejecting com.widevine.alpha describes a browser Google does not ship.",
  },
  {
    disabledBy: "encryptionKey",
    key: "portableProfile",
    cat: "session",
    label: "Portable profile",
    type: "check",
    desc: "Keep the cookie encryption key inside the profile folder, so it can be copied to another machine with sessions intact.",
    hint: "The cookie database is then effectively unencrypted at rest. Needs build 151.",
    keywords: "--portable-profile cookies move copy machine",
    why:
      "Everything else in a profile already survives a copy. Cookies do not, because they are sealed with a key the OS keychain holds for the machine that created them.",
  },
  {
    key: "encryptionKey",
    cat: "session",
    label: "Cookie encryption key",
    type: "password",
    full: true,
    placeholder: "supply your own — nothing sensitive is written to disk",
    keywords: "--profile-encryption-key cookies portable",
    why:
      "The stronger form of a portable profile: you hold the key, so no key material is stored beside the cookies. It wins when both are set. Redacted in the preview and dropped on export — keep your own copy, because a lost key is a lost cookie jar.",
  },
  { key: "userDataDir", cat: "session", label: "Data directory", type: "text", full: true, mono: true, placeholder: "profiles/<id>/userdata", keywords: "--user-data-dir storage path" },
  {
    key: "extraArgs",
    cat: "session",
    label: "Extra flags",
    type: "custom",
    custom: "extraArgs",
    full: true,
    mono: true,
    placeholder: "--foo --bar=1",
    keywords: "raw chrome switches append",
    why: "Appended verbatim, after everything else — so a switch here wins where Chromium takes the last occurrence.",
  },
];

/** Fields belonging to a category, in schema order. */
export function fieldsIn(cat: CategoryId): FieldDef[] {
  return FIELDS.filter((f) => f.cat === cat);
}

export function fieldByKey(key: string): FieldDef | undefined {
  return FIELDS.find((f) => f.key === key);
}

/**
 * Has the user explicitly set this field?
 *
 * This drives the rail badges and the per-field dot, and it deliberately means "you chose this",
 * NOT "differs from the built-in default". Brand defaults to Chrome and platform to the host, but
 * the user did not pick those, so counting them would make every fresh profile look customised and
 * the badge would answer nothing. The question worth answering is "what did I touch?", which is the
 * one you have when a profile misbehaves.
 *
 * `defaultOn` fields invert the test: farbling noise is on unless turned off, so only `false` counts.
 */
export function isFieldSet(profile: Record<string, unknown>, f: FieldDef): boolean {
  const v = profile[f.key];
  if (f.defaultOn) return v === false;
  if (v === undefined || v === null || v === "" || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Count of explicitly-set fields in a category — the rail badge. */
export function countSet(profile: Record<string, unknown>, cat: CategoryId): number {
  return fieldsIn(cat).reduce((n, f) => n + (isFieldSet(profile, f) ? 1 : 0), 0);
}

/** Search across every category: label, hint, description, why-text and keywords. */
export function searchFields(query: string): FieldDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return FIELDS.filter((f) =>
    `${f.label} ${f.desc ?? ""} ${f.hint ?? ""} ${f.why ?? ""} ${f.keywords ?? ""} ${f.key}`
      .toLowerCase()
      .includes(q),
  );
}
