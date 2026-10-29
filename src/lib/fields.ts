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

import { newProfile } from "./newProfile";
import { t, tx } from "./i18n";

export type CategoryId = "identity" | "browser" | "hardware" | "network" | "rendering" | "session" | "cloud";

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
    label: tx("Identity"),
    title: tx("Identity"),
    blurb:
      tx("Who this profile is. The seed drives a coherent persona; a captured fingerprint replaces it with a real machine's values."),
  },
  {
    id: "browser",
    label: tx("Browser"),
    title: tx("Browser"),
    blurb: tx("Which build to launch, and what it claims to be."),
  },
  {
    id: "hardware",
    label: tx("Hardware"),
    title: tx("Hardware"),
    blurb: tx("The machine the persona claims. An explicit value beats the persona, which beats the real one."),
  },
  {
    id: "network",
    label: tx("Network"),
    title: tx("Network & locale"),
    blurb: tx("Where traffic exits, and everything that should agree with it."),
  },
  {
    id: "rendering",
    label: tx("Rendering"),
    title: tx("Rendering"),
    blurb: tx("What canvas, WebGL and audio report."),
  },
  {
    id: "session",
    label: tx("Session"),
    title: tx("Session & data"),
    blurb: tx("What survives a restart, and what moves between machines."),
  },
  {
    id: "cloud",
    label: tx("Cloud"),
    title: tx("Cloud"),
    blurb: tx("Running this profile on Clearcote's servers instead of this PC: where its traffic leaves, and what it keeps."),
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
  /** Static options. A runtime-populated dropdown uses `custom` instead. `when` hides an option the
   *  profile cannot use (a 1 GB phone value on a desktop platform); a value already saved on the
   *  profile is always shown, so hiding an option never silently changes a profile. */
  options?: { value: string; label: string; when?: (p: Record<string, unknown>) => boolean }[];
  /** A select whose values are numbers: the editor stores the chosen option as a number, the same
   *  shape the number inputs store, rather than the option's string. */
  numeric?: boolean;
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
    | "cloud"
    | "fingerprintProfile"
    | "browserVersion"
    | "proxy"
    | "seed"
    | "tags"
    | "extraArgs"
    | "canvasBridgeAllow"
    | "canvasBridgeDeny"
    | "gpuModel";
  /** Rendered INSIDE the named field's bespoke control rather than on its own — the GPU vendor and
   *  renderer strings, which the model picker shows only in its Custom mode. The panel skips such
   *  a field; a search hit or a coherence deep-link lands on the host instead. The field stays in
   *  the schema so it keeps its key, its search text and its place in the badge count. */
  hostedBy?: string;
  /** A control that PRESENTS other keys and stores nothing under its own (the model picker over
   *  `gpuVendor` + `gpuRenderer`). It shows the "you set this" dot when any of them is set, and is
   *  left out of the badge count so the keys are not counted twice. */
  reads?: string[];
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

/** Both avail fields. The full screen size typed as avail is a screen with no taskbar: not a lie,
 *  but a rare shape that stands out, so the copy points at the real work area instead. */
const AVAIL_WHY =
  tx("The work area: the screen minus the taskbar, e.g. 1920 × 1032 on a 1920 × 1080 Windows 11 screen at 100 %. The full screen size here describes a screen with no taskbar, which is rare and stands out. Left empty under a seed, capture or Light stealth, it is not this display's own value, so matching this display means typing all four fields.");

export const FIELDS: FieldDef[] = [
  // ── Identity ──────────────────────────────────────────────────────────────
  { key: "name", cat: "identity", label: tx("Name"), type: "text", full: true, placeholder: tx("e.g. Acme — US East") },
  {
    key: "fingerprint",
    cat: "identity",
    label: tx("Fingerprint seed"),
    type: "custom",
    custom: "seed",
    full: true,
    mono: true,
    keywords: "--fingerprint persona random",
    why: tx("Drives the whole persona. The same seed always produces the same identity, so keep it to keep the identity."),
  },
  {
    key: "fingerprintProfile",
    cat: "identity",
    label: tx("Captured fingerprint"),
    type: "custom",
    custom: "fingerprintProfile",
    full: true,
    keywords: "--fingerprint-profile library import real machine gpu",
    why:
      tx("Adopts a real machine's GPU, screen, fonts, voices and WebGL. Its fields override the seed persona; anything it does not carry falls back to the seed. Strongest coherence comes from a capture whose GPU vendor matches this host."),
  },
  { key: "tags", cat: "identity", label: tx("Tags"), type: "custom", custom: "tags", placeholder: "us, social" },
  { key: "group", cat: "identity", label: tx("Group"), type: "text", placeholder: tx("optional") },
  { key: "notes", cat: "identity", label: tx("Notes"), type: "textarea", full: true, placeholder: tx("anything worth remembering") },

  // ── Browser ───────────────────────────────────────────────────────────────
  {
    key: "browserVersion",
    cat: "browser",
    label: tx("Browser version"),
    type: "custom",
    custom: "browserVersion",
    keywords: "pro free 151 150 149 revision r15 pin",
    why:
      tx("Latest is the newest of your tier. A Pro build needs a licence key in Settings. Latest and a bare major both follow the current Pro pin, which moves when a rebuild ships — pin a revision for a reproducible run."),
  },
  {
    key: "platform",
    cat: "browser",
    label: tx("Platform"),
    type: "select",
    options: [
      { value: "windows", label: "windows" },
      { value: "linux", label: "linux" },
      { value: "macos", label: "macos" },
      { value: "android", label: tx("android — mobile persona") },
    ],
    hint: tx("Defaults to this host."),
    keywords: "--fingerprint-platform mobile",
    why:
      tx("Android is a best-effort phone identity: mobile UA and UA-CH, touch, a phone viewport, portrait orientation, no PDF plugin and a Mali/Adreno GPU."),
  },
  { key: "platformVersion", cat: "browser", label: tx("Platform version"), type: "text", placeholder: "15.0.0", keywords: "--fingerprint-platform-version ua-ch" },
  {
    defaultOption: "",
    key: "brand",
    cat: "browser",
    label: tx("Brand"),
    type: "select",
    options: [
      // Unset is the launcher's own default, which is Chrome — offered explicitly so choosing it
      // stores nothing rather than pinning a value the default would have supplied anyway.
      { value: "", label: tx("(default — Chrome)") },
      { value: "Chrome", label: "Chrome" },
      { value: "Edge", label: "Edge" },
      { value: "Opera", label: "Opera" },
      { value: "Vivaldi", label: "Vivaldi" },
      { value: "Chromium", label: "Chromium" },
    ],
    keywords: "--fingerprint-brand ua-ch google",
    why:
      tx("Claiming Google Chrome commits the build to everything Google's ships — including the Widevine CDM. Chromium is what a de-Googled build honestly is, and is held to less."),
  },
  { key: "brandVersion", cat: "browser", label: tx("Brand version"), type: "text", placeholder: "151.0.0.0", keywords: "--fingerprint-brand-version" },
  {
    defaultOption: "",
    key: "tlsProfile",
    cat: "browser",
    label: tx("TLS profile"),
    type: "select",
    options: [
      { value: "", label: tx("match persona (default)") },
      { value: "native", label: tx("native — the build's own TLS") },
      { value: "chrome-151", label: "chrome-151" },
      { value: "chrome-150", label: "chrome-150" },
      { value: "chrome-149", label: "chrome-149" },
    ],
    keywords: "--fingerprint-tls-profile clienthello ja3",
    why:
      tx("Keeps the TLS ClientHello coherent with the Chrome version the persona claims, instead of always emitting the build's native one."),
  },
  {
    key: "blockThirdPartyCookies",
    cat: "browser",
    label: tx("Block third-party cookies"),
    type: "check",
    desc: tx("Block cookies from other sites embedded in a page."),
    hint: tx("Off by default: third-party cookies are allowed, as in Chrome."),
    keywords: "--block-third-party-cookies --allow-third-party-cookies 3pc cross-site iframe embedded login sso payment",
    why:
      tx("Chrome allows third-party cookies, and embedded sign-in, payment and challenge frames rely on them. Block them only for a site that should not see them. Builds before 154 r36 block them unless told otherwise, so an unticked profile tells them to allow; set a choice here rather than on the browser's own settings page, which this overrides."),
  },

  // ── Hardware ──────────────────────────────────────────────────────────────
  {
    key: "lightStealth",
    cat: "hardware",
    label: tx("Light stealth"),
    type: "check",
    desc: tx("Spoof only the metadata axes that survive strict checks, through the native switches — no persona, no farbling."),
    hint: tx("Rendering, TLS and the real Chrome version are left untouched. Screen is deliberately not spoofed."),
    keywords: "preset narrow surface",
    why:
      tx("Not strictly better than the default: it trades a broad persona for a much narrower surface. In our own lab runs it scored worse on an audit suite. Test it against your target."),
  },
  {
    key: "hardwareConcurrency",
    cat: "hardware",
    label: tx("CPU cores"),
    type: "select",
    numeric: true,
    defaultOption: "",
    // A list, not a free number: real desktops report an even thread count, and a typed 2 or 5 next
    // to a modern GPU is a contradiction nobody meant to make. Unset keeps the persona's own value.
    options: [
      { value: "", label: tx("(persona default)") },
      { value: "4", label: "4" },
      { value: "6", label: "6" },
      { value: "8", label: "8" },
      { value: "12", label: "12" },
      { value: "16", label: "16" },
      { value: "20", label: "20" },
      { value: "24", label: "24" },
      { value: "28", label: "28" },
      { value: "32", label: "32" },
    ],
    keywords: "--fingerprint-hardware-concurrency navigator hardwareconcurrency threads cpu",
    why:
      tx("navigator.hardwareConcurrency: logical threads. Pick what the machine you claim would have; with Use real GPU on a fast card, 16 or more is typical. A count below this PC's also limits the browser to that many CPUs."),
  },
  {
    key: "deviceMemory",
    cat: "hardware",
    label: tx("Memory (GB)"),
    type: "select",
    numeric: true,
    defaultOption: "",
    // A CLOSED set, not a free number. Chromium reports RAM rounded to the nearest power of two and
    // then clamped — desktop to [2, 32], Android to [1, 8] (see
    // third_party/blink/common/device_memory/approximated_device_memory.cc, limits updated in
    // crbug.com/454354290; the old 8 GB ceiling everyone remembers is long gone). The engine's
    // persona path quantizes to a power of two but does NOT apply the clamp, so a value outside the
    // range passes straight through to the page — measured: 16 arrives as 16. Offering a text box
    // invited a 64 that no browser can report, so the choice is constrained here instead.
    options: [
      { value: "", label: tx("(persona default)") },
      { value: "1", label: tx("1 — Android only"), when: (p) => String(p.platform) === "android" },
      { value: "2", label: "2" },
      { value: "4", label: "4" },
      { value: "8", label: "8" },
      { value: "16", label: "16" },
      { value: "32", label: tx("32 — desktop maximum") },
    ],
    keywords: "--fingerprint-device-memory navigator devicememory ram",
    why:
      tx("navigator.deviceMemory, reported as a power of two. Desktop Chromium clamps it to 2–32 and Android to 1–8, so a machine with 64 GB still reports 32."),
  },
  {
    key: "screenWidth",
    cat: "hardware",
    label: tx("Screen width"),
    type: "number",
    placeholder: tx("persona default"),
    group: tx("Screen dimensions"),
    // Static copy, so it has to hold on both sides of 154 r36 (src/lib/coherence.ts,
    // typedScreenReachesCss): before it a typed size under a seed, capture or Light stealth reaches
    // screen.* but not the CSS media queries; from it on both take the typed size.
    groupNote:
      tx("Best left empty: the seed or capture supplies a screen that agrees with itself. Before 154 r36, a typed size under a seed, capture or Light stealth can disagree with what CSS media queries report; from r36 on, typing this display's own four values is fine."),
    keywords: "--fingerprint-screen-width display",
    why:
      tx("Empty uses the persona's screen, or this display when there is no persona. On builds before 154 r36, with a seed, a captured fingerprint or Light stealth active, a typed size reaches screen.* but not the CSS media queries, so pages read two different screens, even when the size matches your own monitor. From 154 r36 on both report the typed size: typing all four of this display's values is fine, while any other size is still a faked screen the real window cannot match."),
  },
  { group: tx("Screen dimensions"), key: "screenHeight", cat: "hardware", label: tx("Screen height"), type: "number", placeholder: tx("persona default"), keywords: "--fingerprint-screen-height display" },
  { group: tx("Screen dimensions"), key: "availWidth", cat: "hardware", label: tx("Avail width"), type: "number", placeholder: tx("persona default"), keywords: "--fingerprint-avail-width taskbar", why: AVAIL_WHY },
  { group: tx("Screen dimensions"), key: "availHeight", cat: "hardware", label: tx("Avail height"), type: "number", placeholder: tx("persona default"), keywords: "--fingerprint-avail-height taskbar", why: AVAIL_WHY },
  { stepAny: true, key: "colorDepth", cat: "hardware", label: tx("Colour depth"), type: "number", placeholder: "24", keywords: "--fingerprint-color-depth" },
  { stepAny: true, key: "devicePixelRatio", cat: "hardware", label: tx("Pixel ratio"), type: "number", placeholder: "1", keywords: "--fingerprint-device-pixel-ratio dpr scaling" },
  { stepAny: true, key: "maxTouchPoints", cat: "hardware", label: tx("Touch points"), type: "number", placeholder: "0", keywords: "--fingerprint-max-touch-points touchscreen", why: tx("0 is a real value — a mouse-only desktop — not an empty one.") },
  {
    // A view over the two stored strings below, not a key of its own: picking a model writes both
    // of them in the form the persona's platform prints, so no profile schema changed and every
    // saved profile reads back as it was (a pair that matches no table entry shows as Custom).
    disabledBy: "disableGpuFingerprint",
    showWhen: (p) => p.platform !== "android",
    reads: ["gpuVendor", "gpuRenderer"],
    key: "gpuModel",
    cat: "hardware",
    label: tx("GPU model"),
    type: "custom",
    custom: "gpuModel",
    full: true,
    keywords: "--fingerprint-gpu-vendor --fingerprint-gpu-renderer webgl unmasked angle graphics card nvidia intel amd geforce radeon random",
    hint: tx("Which graphics card this profile reports to WebGL. Leave it on the persona default unless you need a particular card."),
    why:
      tx("The persona already varies the model with the seed, so profiles no longer all report the same card. If you pick one, the strongest coherence comes from a model of this machine's own GPU maker: driver limits follow the real card, so a claim from another maker can be checked against them. Custom… exposes the raw vendor and renderer strings for a card the list does not have."),
  },
  { hostedBy: "gpuModel", disabledBy: "disableGpuFingerprint", key: "gpuVendor", cat: "hardware", label: tx("GPU vendor"), type: "text", placeholder: tx("persona default"), keywords: "--fingerprint-gpu-vendor webgl unmasked" },
  { hostedBy: "gpuModel", disabledBy: "disableGpuFingerprint", key: "gpuRenderer", cat: "hardware", label: tx("GPU renderer"), type: "text", placeholder: tx("persona default"), keywords: "--fingerprint-gpu-renderer webgl angle unmasked" },
  {
    key: "storageQuota",
    cat: "hardware",
    label: tx("Storage quota (MB)"),
    type: "number",
    placeholder: tx("real (about 10 GB)"),
    hint: tx("Leave empty. Real Chrome reports what the site uses plus 10 GB."),
    keywords: "--fingerprint-storage-quota navigator.storage estimate",
    why:
      tx("navigator.storage.estimate().quota. Chrome reports a fixed quota: the site's own usage plus 10 GB, in normal and incognito windows alike, so an empty field already matches it. A number here replaces that, and a large one describes a value real Chrome never reports."),
  },

  // ── Network ───────────────────────────────────────────────────────────────
  {
    key: "proxy",
    cat: "network",
    label: tx("Proxy"),
    type: "custom",
    custom: "proxy",
    full: true,
    mono: true,
    keywords: "socks5 http https credentials relay egress",
    why:
      tx("One string, credentials inline. An authenticated http/https proxy is served through a local auth-injecting relay, so the browser never prompts. An authenticated socks5 proxy is authenticated by the engine itself (RFC 1929), which stock Chromium cannot do at all — it needs build 151."),
  },
  {
    key: "socks5Udp",
    cat: "network",
    label: tx("Relay UDP through the proxy"),
    type: "check",
    desc: tx("Send WebRTC's UDP through the SOCKS5 proxy too, instead of letting it go direct."),
    hint: tx("Most residential proxies refuse UDP; when they do, the browser quietly falls back."),
    keywords: "--socks5-udp webrtc voice video associate rfc1928 datagram",
    why:
      tx("Ordinary browsers cannot proxy UDP at all, so WebRTC normally bypasses the proxy. This routes it through the same SOCKS5 endpoint that already carries TCP. It needs a proxy that permits the UDP command — a self-hosted one usually does, a residential vendor usually does not. Many residential proxies move a sticky session to another exit the first time UDP goes through it, and keep it there; with this on, the app sends that first UDP before it looks up the exit (at launch, Resolve from proxy and Check), so the address you see is the one the browser uses."),
  },
  {
    key: "transparentProxy",
    cat: "network",
    label: tx("Transparent proxy"),
    type: "check",
    desc: tx("Hide the proxy from request headers and connection timing."),
    hint: tx("Only does something with a proxy set. Needs build 152 r22 or newer."),
    keywords: "--transparent-proxy proxy-connection header timing hide proxy detection",
    why:
      tx("Through an HTTP proxy a browser sends a Proxy-Connection header on plain-HTTP requests, and every proxied connection shows proxy-shaped connect and TLS timing. This sends Connection instead and reports the timing like a reused connection."),
  },
  {
    onValue: true,
    offValue: false,
    key: "geoip",
    cat: "network",
    label: "geoip",
    type: "check",
    desc: tx("At launch, fill any unset timezone, language, geolocation and WebRTC IP from the proxy's exit region."),
    hint: tx("On by default, and switched on automatically when you add a proxy. Values you set yourself always win."),
    keywords: "auto match exit region",
    why:
      tx("Without this, and without a geolocation set, the Geolocation API reports the host's real position — the proxy alone does not move it."),
  },
  { key: "timezone", cat: "network", label: tx("Timezone"), type: "text", placeholder: "America/New_York", keywords: "--timezone iana", why: tx("Unset, a timezone coherent with the locale is derived, rather than leaking the host's (often UTC on a server).") },
  { key: "acceptLanguage", cat: "network", label: "Accept-Language", type: "text", placeholder: "en-US,en", keywords: "--accept-lang navigator.languages locale" },
  {
    key: "location",
    cat: "network",
    label: tx("Geolocation"),
    type: "text",
    placeholder: tx("lat,lng"),
    keywords: "--fingerprint-location gps coordinates position",
    why: tx("What the Geolocation API reports, once a page has permission. Unset and with geoip off, that is your real position."),
  },
  {
    key: "webrtcIp",
    cat: "network",
    label: "WebRTC IP",
    type: "text",
    placeholder: tx("proxy egress IP"),
    keywords: "--webrtc-ip srflx stun leak",
    why: tx("What WebRTC reports as the public address. “Resolve from proxy” fills it with the proxy's exit, and every launch looks that exit up again while the field still holds it, so a proxy that moves to another address does not leave WebRTC behind. Type an address to pin it."),
  },
  {
    defaultOption: "on",
    key: "webrtcMdns",
    cat: "network",
    label: "WebRTC mDNS",
    type: "select",
    options: [
      { value: "on", label: tx("on — hide local IPs (default)") },
      { value: "off", label: tx("off — expose the LAN IP") },
    ],
    keywords: "mdns local candidates lan",
    why:
      tx("Real Chrome hides local host candidates behind a .local name, and so does this by default. Switching it off re-exposes your private IP to every page."),
  },

  // ── Rendering ─────────────────────────────────────────────────────────────
  {
    onValue: true,
    offValue: false,
    key: "fingerprintNoise",
    cat: "rendering",
    label: tx("Farbling noise"),
    type: "check",
    defaultOn: true,
    desc: tx("Per-site noise on canvas, WebGL, audio and client rects. On by default."),
    hint: tx("Turn it off for natural, unperturbed surfaces — best paired with a captured profile."),
    keywords: "--disable-fingerprint-noise farble canvas audio",
    why: tx("Identity spoofs (UA, screen, GPU, persona) stay on either way; this only affects the noised surfaces."),
  },
  {
    key: "disableGpuFingerprint",
    cat: "rendering",
    label: tx("Use real GPU"),
    type: "check",
    desc: tx("Report this host's actual GPU and WebGL instead of a spoofed one."),
    keywords: "--disable-gpu-fingerprint webgl real",
    why: tx("The most coherent option when no captured profile matches the host's real render."),
  },
  // The two NARROW halves of the switches above, for when the broad one costs more coherence than
  // it buys. Both read as "on by default, and only meaningful when switched off".
  {
    key: "gpuStringSpoof",
    cat: "rendering",
    label: tx("Spoof GPU strings"),
    type: "check",
    defaultOn: true,
    onValue: true,
    offValue: false,
    desc: tx("Report the persona's WebGL vendor and renderer. On by default. Off reports the host's real strings while the limits, extensions and readback stay on the persona."),
    hint: tx("Turning this off is the narrow half of “use real GPU”. Needs 150 r12 or newer."),
    keywords: "--disable-gpu-string-spoof unmasked vendor renderer real software rasterise swiftshader",
    why:
      tx("Turn off for a host that rasterises in software, where a spoofed GPU string cannot be backed by the render. navigator.gpu still follows the wide switch, so WebGPU keeps describing the persona."),
  },
  {
    key: "canvasNoise",
    cat: "rendering",
    label: tx("Canvas 2D noise"),
    type: "check",
    defaultOn: true,
    onValue: true,
    offValue: false,
    desc: tx("Per-site farble on 2D canvas readback. On by default."),
    hint: tx("Turning this off leaves WebGL and audio noised — narrower than switching farbling off entirely. Needs 150 r12 or newer."),
    keywords: "--disable-canvas-noise getImageData toDataURL farble 2d",
    why:
      tx("Some sites hash a 2D canvas and reject anything perturbed, while still wanting the other surfaces noised. This unfarbles that one surface rather than the whole process."),
  },
  {
    onValue: "hlsl",
    key: "shaderDialect",
    cat: "rendering",
    label: tx("HLSL shader dialect"),
    type: "check",
    desc: tx("Re-translate shaders to HLSL for a Windows persona running on a Linux host."),
    hint: tx("No effect on a Windows host. Needs build 151."),
    keywords: "CLEARCOTE_SHADER_DIALECT angle spirv vulkan d3d11 getTranslatedShaderSource",
    why:
      tx("A Windows persona claims a Direct3D11 renderer, but on Linux the Vulkan backend answers with SPIR-V, and the two contradict each other. Off by default: the re-translation is a different code path from the one that drew, so a shader it cannot translate falls back to the honest answer."),
  },
  {
    key: "canvasBridgeUrl",
    cat: "rendering",
    group: tx("Canvas bridge"),
    groupNote: tx("Experimental — needs a bridge host and a build with bridge support. Forces --no-sandbox."),
    label: tx("Canvas bridge URL"),
    type: "text",
    full: true,
    mono: true,
    placeholder: "ws://host:port/path",
    keywords: "--canvas-bridge-url remote gpu readback experimental",
    why:
      tx("Forwards canvas and WebGL readback to a remote real-GPU host, so pixel hashes match the claimed GPU. Needs a bridge host and a build with bridge support, and forces --no-sandbox."),
  },
  { group: tx("Canvas bridge"), showWhen: (p) => !!p.canvasBridgeUrl, key: "canvasBridgeAuth", cat: "rendering", label: tx("Bridge credentials"), type: "password", placeholder: "user:secret", keywords: "--canvas-bridge-auth basic" },
  {
    group: tx("Canvas bridge"),
    showWhen: (p) => !!p.canvasBridgeUrl,
    defaultOption: "",
    key: "canvasBridgeMode",
    cat: "rendering",
    label: tx("Origin policy"),
    type: "select",
    options: [
      { value: "", label: tx("unset") },
      { value: "off", label: tx("off") },
      { value: "all", label: tx("all — bridge everything") },
      { value: "allow", label: tx("allow list") },
      { value: "deny", label: tx("deny list") },
    ],
    keywords: "--canvas-bridge-mode per-origin",
    why:
      tx("Every bridged readback is a network round-trip on the renderer thread, which is itself a timing signal. Restrict bridging to the origins that actually score canvas coherence."),
  },
  { group: tx("Canvas bridge"), showWhen: (p) => !!p.canvasBridgeUrl && p.canvasBridgeMode === "allow", key: "canvasBridgeAllow", cat: "rendering", label: tx("Allow list"), type: "custom", custom: "canvasBridgeAllow", placeholder: "example.com, other.com", keywords: "--canvas-bridge-allow" },
  { group: tx("Canvas bridge"), showWhen: (p) => !!p.canvasBridgeUrl && p.canvasBridgeMode === "deny", key: "canvasBridgeDeny", cat: "rendering", label: tx("Deny list"), type: "custom", custom: "canvasBridgeDeny", placeholder: "example.com", keywords: "--canvas-bridge-deny" },
  {
    group: tx("Canvas bridge"),
    showWhen: (p) => !!p.canvasBridgeUrl,
    defaultOption: "",
    key: "canvasBridgeFallback",
    cat: "rendering",
    label: tx("Cache miss"),
    type: "select",
    options: [
      { value: "", label: tx("unset") },
      { value: "block", label: tx("block — wait for the bridge (default)") },
      { value: "local", label: tx("local — never stall, render here") },
    ],
    keywords: "--canvas-bridge-fallback cold",
  },

  // ── Session ───────────────────────────────────────────────────────────────
  {
    key: "widevine",
    cat: "session",
    label: tx("Widevine (DRM)"),
    type: "check",
    desc: tx("Fetch Google's Widevine CDM and seed it into this profile, so DRM video plays and the Chrome brand holds up."),
    hint: tx("On for new profiles. Downloaded once from Google's own component server, SHA-256 verified, then shared by every profile that uses it."),
    keywords: "eme drm cdm com.widevine.alpha media keys",
    why:
      tx("This build compiles the EME plumbing but cannot bundle Google's proprietary CDM. A browser claiming the Google Chrome brand and then rejecting com.widevine.alpha describes a browser Google does not ship."),
  },
  {
    disabledBy: "encryptionKey",
    key: "portableProfile",
    cat: "session",
    label: tx("Portable profile"),
    type: "check",
    desc: tx("Keep the cookie encryption key inside the profile folder, so it can be copied to another machine with sessions intact."),
    hint: tx("The cookie database is then effectively unencrypted at rest. Needs build 151."),
    keywords: "--portable-profile cookies move copy machine",
    why:
      tx("Everything else in a profile already survives a copy. Cookies do not, because they are sealed with a key the OS keychain holds for the machine that created them."),
  },
  {
    key: "encryptionKey",
    cat: "session",
    label: tx("Cookie encryption key"),
    type: "password",
    full: true,
    placeholder: tx("supply your own — nothing sensitive is written to disk"),
    keywords: "--profile-encryption-key cookies portable",
    why:
      tx("The stronger form of a portable profile: you hold the key, so no key material is stored beside the cookies. It wins when both are set. Redacted in the preview and dropped on export — keep your own copy, because a lost key is a lost cookie jar."),
  },
  {
    key: "startUrl",
    cat: "session",
    label: tx("Start page"),
    type: "text",
    full: true,
    mono: true,
    placeholder: "https://example.com",
    keywords: "homepage url open at launch start page first tab",
    why: tx("Opened when the browser starts. Only http and https addresses are used — anything else is ignored, so this field can never add a command-line switch. A bare host like example.com gets https:// added."),
  },
  { key: "userDataDir", cat: "session", label: tx("Data directory"), type: "text", full: true, mono: true, placeholder: "profiles/<id>/userdata", keywords: "--user-data-dir storage path" },
  {
    key: "extraArgs",
    cat: "session",
    label: tx("Extra flags"),
    type: "custom",
    custom: "extraArgs",
    full: true,
    mono: true,
    placeholder: "--foo --bar=1",
    keywords: "raw chrome switches append",
    why: tx("Appended verbatim, after everything else — so a switch here wins where Chromium takes the last occurrence."),
  },
  {
    key: "cloud",
    cat: "cloud",
    label: tx("Running in the cloud"),
    type: "custom",
    custom: "cloud",
    full: true,
    keywords: "hosted server servers remote residential ip exit country cookies traffic cap gb adblock record video api key",
  },
];

/**
 * The options a select shows for this profile: the ones whose `when` passes, plus the value the
 * profile already holds even when no option names it (an option hidden for this platform, or a
 * number saved before the field was a list). Showing it keeps the select honest: a dropdown that
 * cannot display the stored value would render the first option and look as if it applied.
 */
export function selectOptions(
  f: FieldDef,
  profile: Record<string, unknown>,
  current: string,
): { value: string; label: string }[] {
  const all = f.options ?? [];
  const shown = all.filter((o) => !o.when || o.when(profile) || o.value === current);
  if (current !== "" && !shown.some((o) => o.value === current)) shown.push({ value: current, label: t("{current} (set before)", { current }) });
  return shown.map(({ value, label }) => ({ value, label }));
}

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
  // A view over other keys is set when any of them is.
  if (f.reads) return f.reads.some((k) => fieldByKey(k) ? isFieldSet(profile, fieldByKey(k)!) : false);
  const v = profile[f.key];
  // The cloud block is an object of options: set when any of them is.
  if (f.key === "cloud") return !!v && typeof v === "object" && Object.values(v as object).some((x) => x !== undefined);
  if (f.defaultOn) return v === false;
  if (v === undefined || v === null || v === "" || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Count of explicitly-set fields in a category — the rail badge. A view over other keys (`reads`)
 *  is skipped, so the keys it presents are counted once, under their own names. */
export function countSet(profile: Record<string, unknown>, cat: CategoryId): number {
  return fieldsIn(cat).reduce((n, f) => n + (!f.reads && isFieldSet(profile, f) ? 1 : 0), 0);
}

/** The field a panel lays out for `key`: the field itself, or the control that hosts it. */
export function hostFieldFor(key: string): FieldDef | undefined {
  const f = fieldByKey(key);
  return f?.hostedBy ? (fieldByKey(f.hostedBy) ?? f) : f;
}

/** Search across every category: label, hint, description, why-text and keywords. */
export function searchFields(query: string): FieldDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // The English text and, in another language, what the panel shows: a search matches either.
  const shown = (s?: string) => (s ? t(s) : "");
  return FIELDS.filter((f) => {
    const english = `${f.label} ${f.desc ?? ""} ${f.hint ?? ""} ${f.why ?? ""} ${f.keywords ?? ""} ${f.key}`;
    const local = `${shown(f.label)} ${shown(f.desc)} ${shown(f.hint)} ${shown(f.why)}`;
    return english.toLowerCase().includes(q) || local.toLowerCase().includes(q);
  });
}

/**
 * The editor's Simple view: the settings most hand-made profiles need, on one page. Everything else
 * keeps its default (or a template's value) and stays one click away under "All settings". The four
 * screen fields stay together so they render as their group, with "Use this display".
 */
export const ESSENTIAL_KEYS = [
  "name",
  "proxy",
  "platform",
  "group",
  "tags",
  "notes",
  "startUrl",
  "screenWidth",
  "screenHeight",
  "availWidth",
  "availHeight",
] as const;

export function isEssential(key: string): boolean {
  return (ESSENTIAL_KEYS as readonly string[]).includes(key);
}

export function essentialFields(): FieldDef[] {
  return ESSENTIAL_KEYS.map((k) => fieldByKey(k)).filter((f): f is FieldDef => !!f);
}

/** Settings you chose that the Simple view does not show (the seed is always there, so it is not one).
 *  A control over other keys (the GPU model over its two strings) counts once; the keys it hosts do
 *  not. A value every new profile starts with (geoip and Widevine on) is not a choice, so it does not
 *  count either. */
export function setOutsideEssentials(profile: Record<string, unknown>): number {
  const start = newProfile("", "") as unknown as Record<string, unknown>;
  return FIELDS.filter((f) => !f.hostedBy && f.key !== "fingerprint" && !isEssential(f.key)).reduce(
    (n, f) => n + (isFieldSet(profile, f) && !(start[f.key] !== undefined && profile[f.key] === start[f.key]) ? 1 : 0),
    0,
  );
}
