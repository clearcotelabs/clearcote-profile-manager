# Tests

Four layers:

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
  - `profiles.test.ts` — delete to trash + undo + purge (with real files; on Windows also a data
    folder held open, which must leave everything in place), safe ids, `markLaunched` touching only
    `lastLaunchedAt`, and an import that never overwrites.
  - `launch.flow.test.ts` — `launch()` with the network, download and spawn stubbed: licence error
    codes reach the UI, an edit saved during a long first download survives the launch, and the
    plan is learned from a real lease (not from an offline cached one).
  - `launchTarget.test.ts` — what the header pill says (custom binary / plan · build / offline), the
    catalog cache and timeout, the settings merge that keeps the learned plan, and the
    update-check switch.
  - `appupdate.test.ts` — the app's own updates: version order, which file each kind of install
    gets, the checksums file, and the download. Overlapping downloads, a short transfer, and
    progress reported to the window, which must never reorder the file. In the app, sending to the
    window lets Node run queued work before it returns (simulated here with
    `process._tickCallback()`); progress counted beside the pipeline instead of inside it failed
    every in-app update with "Checksum mismatch". Also: a mismatch says whether the bytes arrived
    wrong or changed on the way to disk.
  - `launchError.test.ts` — every launch-failure message the app produces, mapped to a title, a
    plain explanation and one action. Uses the real strings (the screenshot's 403 included).
  - `profileList.test.ts` — sort, grouping, relative times, version chips, the free-plan pin check,
    proxy redaction on cards, and unsaved-change detection.
  - `lifecycle.test.ts` — why a browser stopped (the licence watchdog exits 0 like a normal close;
    only its stderr line tells them apart), the graceful stop and its forced fallback, and what
    closing the window does while browsers run.
  - `storage.test.ts` — which builds can go (Latest, pins, running and the custom binary always
    stay), the plan from real catalog rules and offline, temp copies, the rename-first delete (on
    Windows also a build with a file held open, which must be refused whole), and window placement.
  - `profiledata.test.ts` — the exit place kept on a profile, group rename, export with or without
    secrets, and clearing a Chromium profile's cache while keeping cookies, logins and site storage.
  - `launchparts.test.ts` — the start page as a URL (never a switch, always last), a lease's refusal
    memory and shared check-in, "valid but busy", and one download per build.
  - `listfeatures.test.ts` — the proxy-list import (including host:port:user:pass), filters, group
    order, the exit-place label, exit notices, the one-browser swap, and Shift+click ranges.
- **UI end-to-end (opt-in, real browser)** — `editor.e2e.test.ts` and `ui.e2e.test.ts` drive the
  renderer in Chrome against `next dev`, using its in-browser mock of the Electron bridge. They cover
  what only a browser shows: dialogs (Esc on the top one only, focus trap and return, scroll lock,
  fitting a 560px-tall or phone-width window), the unsaved-changes guard, Ctrl+S, the ⋯ menu,
  delete + Undo, keyboard shortcuts, sorting, card content, the update suggestion and its Settings
  switch, and contrast in both themes.
  `qol.e2e.test.ts` covers filters, groups (fold, move, rename, ungroup), multi-select and bulk
  actions, the swap on a one-browser plan, exit notices, export with secrets, the proxy-list import,
  and Settings → General, Storage and Licence. It drives the mock's opt-in hooks
  (`clearcote.mock.launch`/`limit`/`storage`/`target`/`license`/`prefetch` in localStorage, and
  `window.__clearcoteMock.exit()`), which play the desktop app's side.
  Run: `npm run next:dev -- -p 3100`, then
  `CLEARCOTE_UI_E2E=1 CLEARCOTE_UI_BROWSER=<chrome.exe> npx vitest run tests/ui.e2e.test.ts tests/editor.e2e.test.ts tests/qol.e2e.test.ts`.
- **App end-to-end (opt-in, the real Electron app)** — `app.e2e.test.ts` starts the built app with a
  throwaway `--user-data-dir` (never your real profiles) and checks the IPC behind trash/undo, the
  real launch target, `lastLaunchedAt` written by the main process, the plan learned from a lease,
  and the update check on every start. An update downloaded through the window, from a local
  release of random bytes, must land byte-for-byte; plain-Node runs never showed the reordering
  that broke this, only the real window does. With a key it also launches real browsers: Stop must leave
  Chromium's `exit_type` at "Normal" (a hard kill leaves "Crashed"), a browser killed from outside
  must say so on its card, and closing the window must hide to the tray, remember an "ask" answer,
  or close every browser properly before quitting. Build pruning, temp copies and cache clearing
  run against a throwaway cache and temp folder, never the real ones.
  Run: `npm run build`, then `CLEARCOTE_APP_E2E=1 CLEARCOTE_LICENSE_KEY=cc_lic_... npx vitest run tests/app.e2e.test.ts`.
  Set `E2E_OUTCOMES=<file>` to record which of the two accepted outcomes the licence-dependent
  tests took.

  > Every suite cleans up after itself: a full run leaves nothing in `%TEMP%`. Create temp folders
  > in hooks, not at module level — a skipped suite's module and describe body still run.
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
