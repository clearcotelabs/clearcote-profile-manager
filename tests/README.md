# Tests

Two layers:

- **Unit (vitest, runs in CI)** — Run: `npm test`.
  - `fpargs.test.ts` — the shared switch builder (`electron/fpargs.ts`) that BOTH the launcher and
    the UI preview use. This is where SDK parity is pinned: lightStealth, the native metadata
    overrides, locale coherence, webrtcMdns, the canvas bridge, and the captured-profile screen
    guard. Also pins the module's own sha256 against `node:crypto` (the lightStealth seed→row
    mapping must match the Node and Python SDKs, and the renderer can't use `node:crypto`).
  - `launcher.test.ts` — `electron/launcher.ts buildArgs`, i.e. the command line that is ACTUALLY
    spawned: captured-profile gzip round-trip, donor `navigator.languages` recovery, the resolved
    user-data-dir, and extraArgs ordering.
  - `fpmeta.test.ts` — what counts as a valid capture, and the screen-guard wiring.
  - `catalog.test.ts` — version + PRO **revision** resolution (`150.0.7871.114-r9`, bare `r9`) and
    the selector carried to `/download/pro`.
  - `args.test.ts` — the renderer's preview builder. `proxy.test.ts` — proxy parse / redact / relay.

  > Note: `args.test.ts` used to be the only arg coverage, and it tests the **preview** builder.
  > The launcher was a separate hand-maintained copy and had silently drifted from it. Both now
  > delegate to `electron/fpargs.ts`; keep new switches there so one test run covers both paths.
- **Runtime confirmation (manual, needs the binary)** — `confirm-applied.py`. Launches the real
  Clearcote binary with every setting set and probes the in-page surface to confirm each is actually
  applied. Run: `pip install playwright && CLEARCOTE_BINARY=<chrome.exe> python tests/confirm-applied.py`.

## What actually applies (re-confirmed against 151 r16 — `applied.e2e.test.ts`)

`tests/applied.e2e.test.ts` launches through the app's own launcher and reads each setting back off
the page. Run it with `CLEARCOTE_E2E=1 CLEARCOTE_BINARY=<chrome.exe> CLEARCOTE_LICENSE_KEY=...`.
All 15 checks pass on 151 r16: platform + platform version, brand, cores, memory, screen, avail,
colour depth, pixel ratio, touch points, timezone, Accept-Language, storage quota, geolocation, GPU
vendor/renderer, window-frame coherence, and the three noise/GPU switches.

Two things worth recording, both measured rather than assumed:

- **`deviceMemory` is sanitized by the engine, so the app needs no guard.** Asked for 1 it reports
  2, for 6 it reports 4, and for 64 or 128 it reports 32 — Chromium's power-of-two quantization plus
  the desktop [2, 32] clamp (Android [1, 8]). The 8 GB ceiling from the original W3C text was raised
  in crbug.com/454354290, so 16 and 32 are ordinary desktop values. A coherence rule here was
  written and then removed: it would have flagged values the browser silently corrects.
- **`gpuStringSpoof: false` is genuinely narrow.** It swaps the WebGL vendor/renderer for the real
  ones while cores, screen and timezone stay on the persona — verified side by side.

## Historical: the 149-era table

`gpuVendor` / `gpuRenderer` and `location` apply as of **clearcote-browser v0.1.0-pre.10**
(commit `d7bbe67` wired `--fingerprint-gpu-vendor/-renderer` + `--fingerprint-location`, which were
previously declared-but-unread). Run `confirm-applied.py` against a **pre.10+** binary.

| Setting | Switch | Applies? | Probe |
|---|---|:--:|---|
| `fingerprint` (seed) | `--fingerprint` | ✅ | deterministic persona |
| `platform` | `--fingerprint-platform` | ✅ | `navigator.platform` = `Win32`, UA-CH platform `Windows` |
| `brand` | `--fingerprint-brand` | ✅ | UA-CH brands include `Google Chrome` |
| `hardwareConcurrency` | `--fingerprint-hardware-concurrency` | ✅ | `navigator.hardwareConcurrency` |
| `timezone` | `--timezone` | ✅ | `Intl…timeZone` + `Date` offset |
| `acceptLanguage` | `--accept-lang` | ✅ | `navigator.language` (primary) |
| `gpuVendor` / `gpuRenderer` | `--fingerprint-gpu-vendor/-renderer` | ✅ (pre.10+) | WebGL `UNMASKED_VENDOR/RENDERER` (switch > profile > seed) |
| `location` | `--fingerprint-location` | ✅ (pre.10+) | `navigator.geolocation.getCurrentPosition` (permission still required) |
| `webrtcIp` | `--webrtc-ip` | ✅ | WebRTC `srflx` candidate IP |
| `proxy` (incl. auth) | local relay → `--proxy-server` | ✅ | egress IP via the proxy |
| `fingerprintProfile` | `--fingerprint-profile` | ✅ | GPU/screen/voices/fonts/etc. |

### Known engine gaps (the manager emits the switch, but the engine currently ignores it)

| Setting | Status |
|---|---|
| `acceptLanguage` → `navigator.languages` | Partial — only the **primary** tag appears in `navigator.languages` (the header + `navigator.language` are correct). The full-array surface is not implemented yet. |

This is a clearcote-browser engine issue, tracked separately from the profile-manager. Until it
lands, the editor still exposes the full Accept-Language (so profiles are forward-compatible), but
`navigator.languages` shows only the primary tag.
