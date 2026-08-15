# Clearcote Profile Manager

A desktop app to **create, save, organize, and launch [Clearcote](https://github.com/clearcotelabs/clearcote-browser) browser profiles** — one coherent, persistent identity per profile (fingerprint seed + proxy + persistent storage), opened as a normal interactive browser window you drive yourself.

![Clearcote Profile Manager](docs/screenshots/profile-manager.png)

> **Status:** built — profile create/edit/launch, proxy geo-resolve, import/export, a light/dark theme (dark by default), and a portable Windows build. Full design + phases in **[PLAN.md](PLAN.md)**.

<details>
<summary>More screenshots — meet Clyde, light theme, editor</summary>

**Empty state — meet Clyde, the Clearcote chameleon** (he bobs, blinks, and shifts hue)

![Empty state with Clyde the chameleon](docs/screenshots/empty-state.png)

**Light theme** (toggle in the header; dark is the default)

![Light theme](docs/screenshots/light-theme.png)

**Profile editor**

![Profile editor](docs/screenshots/editor.png)

</details>

## Download

Prebuilt Windows builds are on the **[Releases page](https://github.com/clearcotelabs/clearcote-profile-manager/releases)** — no need to build from source:

- **Installer** — `Clearcote-Profile-Manager-<version>-setup.exe` · double-click to install.
- **Portable** — `Clearcote-Profile-Manager-<version>-x64.zip` · unzip and run `Clearcote Profile Manager.exe` (no install).

### Verify it's genuine (recommended)

Every release is **built entirely by [GitHub Actions](.github/workflows/release.yml)** on a `windows-latest` runner from the tagged commit — not on anyone's machine — so the build is public and auditable. Two independent ways to confirm your download wasn't tampered with:

```bash
# 1. Provenance — cryptographically proves it came from THIS repo's CI at the release commit
gh attestation verify Clearcote-Profile-Manager-<version>-setup.exe -R clearcotelabs/clearcote-profile-manager

# 2. Checksum — SHA256SUMS.txt ships with every release
sha256sum -c SHA256SUMS.txt          # macOS / Linux
# Windows (PowerShell):
# (Get-FileHash .\Clearcote-Profile-Manager-<version>-setup.exe -Algorithm SHA256).Hash
```

> The app is **unsigned**, so Windows SmartScreen may warn on first run (**More info → Run anyway**). Proper Authenticode signing needs a paid certificate; until then, the public-CI build + provenance attestation + checksums are the trust anchor.

## Why

Clearcote is driven by command-line identity flags (`--fingerprint`, `--fingerprint-platform`, `--timezone`, `--accept-lang`, `--webrtc-ip`, `--proxy-server`, `--user-data-dir`). Juggling many identities by hand is tedious and error-prone. This app gives you a GUI to:

- **Create & save profiles** — each a named identity: fingerprint seed, platform/brand, timezone, language, WebRTC IP, geoip auto-match, proxy, notes/tags.
- **Persist sessions** — every profile gets its own `--user-data-dir`, so cookies/logins/storage survive across launches.
- **Launch in one click** — spawns the verified Clearcote binary with the profile's flags as an interactive window.
- **Organize** — search, tag, group, duplicate, import/export.

It mirrors the [clearcote npm SDK](https://www.npmjs.com/package/clearcote) to **resolve + SHA-256-verify** the browser binary (auto-download) and, with a PRO key, to check out a floating-concurrency lease (see [PRO tier](#pro-tier-license-key)). Launching is a direct, interactive `chrome.exe` spawn — **not** Playwright automation.

## Stealth options

Beyond the basics, each profile exposes Clearcote's full identity surface (all under **Advanced stealth** in the editor, reflected live in the launch-command preview with secrets redacted):

- **Captured fingerprint** — adopt a *real machine's* GPU, screen, fonts, voices & WebGL via `--fingerprint-profile`. Browse the curated [clearcote-profiles](https://github.com/clearcotelabs/clearcote-profiles) library filtered **by GPU vendor** — pick one matching your host so the imported GPU stays coherent with the actual render. Captures taken on a display too small to contain a normal browser window are flagged on import and hidden from the picker by default: the window would end up larger than the screen it claims to sit on, which no real machine produces.
- **Farbling noise** (on by default) — toggle off (`--disable-fingerprint-noise`) so canvas / WebGL / audio return natural, unperturbed values that read as untampered to strict detectors. Best paired with a captured profile; identity spoofs (UA / screen / GPU / persona) stay on.
- **Use real GPU** (`--disable-gpu-fingerprint`) — report the host's actual GPU instead of a spoofed one; the most coherent option when no matching captured profile is available.
- **Storage quota** (`--fingerprint-storage-quota`, MB) — a realistic `navigator.storage.estimate().quota`; a tiny value reads as incognito / a test machine.
- **GPU vendor / renderer, platform & brand version, hardware concurrency** — fine-grained persona overrides.
- **Light stealth** — spoof only a coherent, seed-derived bundle of the metadata axes that survive strict checks (cores, memory, colour depth, pixel ratio, touch points), applied through the native override switches and emitting **no** `--fingerprint`, so the persona machinery and farbling never engage. Rendering, TLS and the real Chrome version are left untouched. Screen size is deliberately not spoofed. Any field you set explicitly wins over the preset. *Not strictly better than the default* — it trades a broad persona for a much narrower surface, so test it against your target.
- **Native metadata overrides** — `deviceMemory`, `colorDepth`, `devicePixelRatio`, `maxTouchPoints` and the screen / avail dimensions, each settable on its own. These are read directly by the getters (flag > persona > real) with no persona machinery behind them. The screen row is the risky one: a faked screen can't be reconciled with the real window and render surface, so set it only when it matches the host's actual display.
- **WebRTC mDNS** — real Chrome hides local host candidates behind a `.local` name, and so does Clearcote by default. Switch it off only if you need routable LAN/P2P candidates — it re-exposes your private IP to every page.
- **Mobile (Android) persona** — pick `android` in the **Platform** selector for a best-effort phone identity: mobile UA / UA-CH, touch, mobile viewport (a phone `--window-size` is set automatically), portrait orientation, no PDF plugin, Mali/Adreno GPU.
- **TLS network persona** (`--fingerprint-tls-profile`) — keep the TLS ClientHello coherent with the persona's *claimed* Chrome version instead of always emitting the build's native TLS. `match-persona` (the default) follows the brand version; `native` keeps it stock. Chromium-core (Chrome/Edge/Brave/Opera share the ClientHello).
- **Canvas bridge** *(experimental)* — forward canvas / WebGL rendering to a remote real-GPU host so the pixel readback matches the claimed GPU, for sites that pixel-hash the canvas. A per-origin policy (bridge everything, or an allow / deny list) and the cold-cache behaviour are both configurable: every bridged readback is a network round-trip on the renderer thread, so it's worth restricting to the origins that actually score canvas coherence. Needs a bridge host and a Clearcote build with canvas-bridge support.

- **Portable profile** *(Clearcote 151 r14+)* — a profile folder already moves between machines by
  copying it, with one exception: cookies. They're sealed with a key the OS keychain / DPAPI holds
  for the machine that created them, so a copied profile decrypts to an empty jar and every session
  is lost. **Portable profile** (`--portable-profile`) keeps that key inside the folder so it travels
  whole — at the cost of the cookie database being effectively unencrypted at rest. **Cookie
  encryption key** (`--profile-encryption-key`) is the stronger form: you hold the key, so nothing
  sensitive is written to disk. It wins when both are set, and is redacted in the preview and on
  export.
- **Widevine (DRM)** — fetch Google's Widevine CDM and seed it into the profile. Clearcote is fully
  open source, so it builds the EME plumbing but cannot bundle Google's proprietary CDM — while
  every profile claims the **Google Chrome** brand by default, and Google's build always ships one.
  A browser that asserts that brand, implements EME, and then rejects `com.widevine.alpha` describes
  a browser Google does not make, readable in a single property lookup (the public audit flags
  exactly this). Opting in downloads the CDM once from Google's own component server — where real
  Chrome gets it — verifies its SHA-256, and shares it across profiles. If you would rather not run
  a proprietary blob, set the profile's brand to something other than Chrome instead: a build
  reporting **Chromium** is honestly what a de-Googled browser is, and is exempt from the check.
- **HLSL shader dialect** *(Clearcote 151 r15+)* — only for a Windows persona on a **Linux** host. A
  page can ask which shader source the graphics backend produced; a Windows persona advertises a
  Direct3D11 renderer while Linux's Vulkan backend answers with SPIR-V, and the two contradict each
  other. This re-translates for that query alone — rendering is untouched. Off by default: it's a
  different code path from the one that drew, so a shader it can't translate falls back to the
  honest answer. A no-op on a Windows host.

> **Tip:** the strongest coherence is a captured profile whose **GPU vendor matches your host** + farbling noise **off**.

### geoip

`geoip` resolves the **proxy's** exit region at launch and fills any timezone / Accept-Language /
**geolocation** / WebRTC IP you left unset; anything you set yourself always wins. Leave it off (and
set no location) and the Geolocation API reports the host's real position — geolocation is not
derived from the proxy on its own. The lookup speaks SOCKS5 with authentication directly, so it works
through the same residential proxies the browser uses.

## PRO tier (license key)

By default the app launches the **free** Clearcote build. If you have a PRO license, paste your key
into **Settings → PRO license key** (or set `CLEARCOTE_LICENSE_KEY`) — **Check** validates it and shows
your plan + slots in use. It's entirely additive: with **no key** the app is unchanged (free binary,
no contact with the license backend).

With a key set, each launch:

- **downloads the license-gated PRO browser** on demand (via the site's authenticated download route,
  SHA-256-verified like the free build, cached per build), and
- **checks out one floating-concurrency slot** — a background heartbeat keeps it alive and the slot is
  released when you stop the profile or close the browser.

The PRO engine refuses to launch without a valid run-token, so a copied binary alone won't run. An
explicit binary in Settings still wins over the PRO auto-download; a revoked/expired key surfaces an
error rather than silently falling back to free.

**Pinning an exact build.** With a key set, the **Browser version** dropdown also lists the published
PRO rebuilds (e.g. `151.0.7922.108-r15`). *Latest* and a bare major both follow the current pin, which
moves whenever a rebuild ships — so pin a revision when you need a run to stay reproducible. Each
revision is cached separately, so switching between them doesn't re-download.

The dropdown is built from the public `/api/v1/versions` catalog, so a newly published major appears
without updating this app.

### Chromium 151 (PRO)

151 is the current PRO engine. Three of its changes are visible here:

- **Authenticated SOCKS5 proxies work** (r14). A `socks5://user:pass@host:port` proxy is now
  authenticated by the engine itself (RFC 1929), which stock Chromium cannot do at all — no local
  relay, no manual prompt. On 149/150 the credentials cannot be carried and the app says so at
  launch rather than letting it look like a bad proxy.
- **Portable profiles** (r14) — see **Portable profile** under *Advanced stealth*.
- **HLSL shader dialect** (r15) — opt-in, for running a Windows persona on a Linux host.

Everything else in 151 is engine-side and needs nothing from this app: the reported browser version
now matches the engine it actually is, device-pixel-ratio agrees across JavaScript / request headers
/ image selection, pointer coordinates agree with the reported window position, and one arithmetic
function now matches the operating system the persona claims.

## Stack

Electron · Next.js (App Router) · React · TypeScript · Tailwind CSS · packaged with electron-builder (Windows-first, matching the browser).

## Quickstart (once implemented — see PLAN.md Phase 1)

```bash
npm install
npm run dev        # Electron shell + Next.js renderer
npm run dist       # build a Windows installer
```

## Layout

| Path | What |
|---|---|
| `electron/` | main process — profile storage, binary resolution, browser launch, IPC |
| `electron/fpargs.ts` | **the** profile → Chromium-switch builder, shared by the launcher and the UI preview so the command line you see is the one that runs |
| `app/` | Next.js renderer (the UI) |
| `src/types/` | shared data model (`Profile`) |
| `tests/` | vitest unit suite (`npm test`) — see [tests/README.md](tests/README.md) |
| `profiles/` | runtime profile store — JSON per profile + per-profile `userdata/`; git-ignored except the example |

## Packaging (Windows)

Releases are cut automatically by [GitHub Actions](.github/workflows/release.yml) when a `v*` tag is pushed (build on a clean `windows-latest` runner → checksums → provenance attestation → GitHub Release). To build locally instead:

```bash
npm run make-icon     # build/icon.ico from the brand mark (once)
npm run dist          # next export + electron compile + electron-builder NSIS installer → release/
```

This produces a signed-able NSIS installer in `release/`. A **portable build** (no installer) is also produced as `release/win-unpacked/` — zip it and run `Clearcote Profile Manager.exe` directly.

> **Note — NSIS installer on Windows:** electron-builder fetches `winCodeSign`, whose archive contains macOS symlinks. Extracting them needs symlink privilege, so on Windows **enable Developer Mode** (Settings → For developers) *or* run the build from an elevated shell once; otherwise `electron-builder` errors with *"Cannot create symbolic link"*. The portable `win-unpacked` build does not require this.

## License

BSD-3-Clause — matching the Clearcote project.
