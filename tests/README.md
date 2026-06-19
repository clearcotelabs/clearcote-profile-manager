# Tests

Two layers:

- **Unit (vitest, runs in CI)** — `args.test.ts`, `proxy.test.ts`. Confirm the profile-manager maps
  every setting to the correct Clearcote switch, and that proxy strings parse / redact / relay-route
  correctly. Run: `npm test`.
- **Runtime confirmation (manual, needs the binary)** — `confirm-applied.py`. Launches the real
  Clearcote binary with every setting set and probes the in-page surface to confirm each is actually
  applied. Run: `pip install playwright && CLEARCOTE_BINARY=<chrome.exe> python tests/confirm-applied.py`.

## What actually applies (confirmed against the Chromium 149 build, 2026-06-19)

| Setting | Switch | Applies? | Probe |
|---|---|:--:|---|
| `fingerprint` (seed) | `--fingerprint` | ✅ | deterministic persona |
| `platform` | `--fingerprint-platform` | ✅ | `navigator.platform` = `Win32`, UA-CH platform `Windows` |
| `brand` | `--fingerprint-brand` | ✅ | UA-CH brands include `Google Chrome` |
| `hardwareConcurrency` | `--fingerprint-hardware-concurrency` | ✅ | `navigator.hardwareConcurrency` |
| `timezone` | `--timezone` | ✅ | `Intl…timeZone` + `Date` offset |
| `acceptLanguage` | `--accept-lang` | ✅ | `navigator.language` (primary) |
| `webrtcIp` | `--webrtc-ip` | ✅ | WebRTC `srflx` candidate IP |
| `proxy` (incl. auth) | local relay → `--proxy-server` | ✅ | egress IP via the proxy |
| `fingerprintProfile` | `--fingerprint-profile` | ✅ | GPU/screen/voices/fonts/etc. |

### Known engine gaps (the manager emits the switch, but the engine currently ignores it)

| Setting | Status |
|---|---|
| `gpuVendor` / `gpuRenderer` | **No-op.** `--fingerprint-gpu-vendor/-renderer` are declared in the engine but nothing reads them — the WebGL renderer is derived from the **seed** (or an **imported fingerprint-profile**, which *does* set it). Set the GPU via the seed or a profile, not these fields. |
| `location` | **No-op.** `--fingerprint-location` is declared but unwired (no geolocation consumer). |
| `acceptLanguage` → `navigator.languages` | Partial — only the **primary** tag appears in `navigator.languages` (the header + `navigator.language` are correct). |

These are clearcote-browser engine issues, tracked separately from the profile-manager. Until they
land, the editor still exposes the fields (so profiles are forward-compatible), but they won't
change the browser.
