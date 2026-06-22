# Tests

Two layers:

- **Unit (vitest, runs in CI)** — `args.test.ts`, `proxy.test.ts`. Confirm the profile-manager maps
  every setting to the correct Clearcote switch, and that proxy strings parse / redact / relay-route
  correctly. Run: `npm test`.
- **Runtime confirmation (manual, needs the binary)** — `confirm-applied.py`. Launches the real
  Clearcote binary with every setting set and probes the in-page surface to confirm each is actually
  applied. Run: `pip install playwright && CLEARCOTE_BINARY=<chrome.exe> python tests/confirm-applied.py`.

## What actually applies (confirmed against the Chromium 149 build)

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
