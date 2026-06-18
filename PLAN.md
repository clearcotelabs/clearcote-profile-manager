# Clearcote Profile Manager — Implementation Plan

A desktop GUI for managing and launching [Clearcote](https://github.com/clearcotelabs/clearcote-browser) browser identities. This document is the design + phased build plan; the repo currently holds the scaffold (data model, project skeleton, `profiles/` store).

---

## 1. Goal & scope

**Goal:** make it effortless to keep many distinct, coherent, persistent browser identities and open any of them as a real interactive window.

A **profile** = a saved Clearcote identity:
- a fingerprint **seed** (drives the coherent persona — GPU, hardware, screen, canvas/WebGL/audio),
- optional platform/brand/timezone/language/WebRTC-IP/geoip overrides,
- an optional **proxy**,
- a dedicated **persistent `--user-data-dir`** so cookies/logins/storage survive,
- metadata (name, notes, tags, group, timestamps).

**In scope (v1):** CRUD profiles, persistent per-profile storage, one-click interactive launch with the verified binary, proxy support, geoip auto-match, search/tag/group, duplicate, import/export, a Settings pane (binary path / auto-download, theme).

**Out of scope (v1):** Playwright/Puppeteer *automation* (that's the SDK's job — see note below), headless runs, scripting. `humanize`/`showCursor` are automation features and intentionally **not** part of an interactive profile.

> **Interactive vs automation.** The SDK's `launch()` returns a Playwright `Browser` for *automation*. This manager instead spawns `chrome.exe` **directly** with the profile's flags so the user drives a normal window. It reuses only the SDK's `executablePath()` (resolve + SHA-256-verify + cache the binary) and `resolveGeo()` (proxy exit-IP → timezone/language/WebRTC).

---

## 2. Architecture

```
┌─────────────────────────────  Electron  ─────────────────────────────┐
│                                                                       │
│  Renderer (Next.js + React + Tailwind)        Main process (Node)     │
│  ───────────────────────────────────         ───────────────────     │
│  • Profile list / cards                       • Profile store (fs):   │
│  • Profile editor form                 IPC      profiles/<id>.json    │
│  • Launch / stop / status        <──────────>  • Binary resolver      │
│  • Settings, search, tags                       (clearcote SDK)       │
│                                                 • Launcher: spawn      │
│                                                   chrome.exe + flags   │
│                                                   + --user-data-dir    │
│                                                 • Running-instance map │
│                                                 • geoip resolve        │
└───────────────────────────────────────────────────────────────────────┘
```

- **Main process** owns the filesystem + child processes (security: the renderer never touches `fs`/`child_process` directly). All actions go through a typed **IPC** surface exposed via a `contextBridge` preload.
- **Renderer** is a Next.js app (App Router, static-exported and loaded by Electron). Tailwind for styling. State in React + a small store (Zustand) or `useReducer`.

### Launch flow
1. Resolve the binary: explicit path → `CLEARCOTE_BINARY` → SDK `executablePath()` (auto-download + verify, cached).
2. If `geoip` is on and a proxy is set, `resolveGeo(proxy)` → fill any unset `timezone` / `acceptLanguage` / `location` / `webrtcIp`.
3. Build the arg list from the profile (`--fingerprint=…`, `--fingerprint-platform=…`, `--timezone=…`, `--accept-lang=…`, `--webrtc-ip=…`, `--proxy-server=…`, `--user-data-dir=profiles/<id>/userdata`, `+ extraArgs`).
4. `spawn(chrome, args)`, track the child in a `Map<profileId, ChildProcess>`, stream status to the renderer; update `lastLaunchedAt`.

---

## 3. Data model

See [`src/types/profile.ts`](src/types/profile.ts) (the source of truth) and [`profiles/example.profile.json`](profiles/example.profile.json). Each profile is one `profiles/<id>.json`; its persistent browser data lives in `profiles/<id>/userdata/`. Profile files are **git-ignored** (they hold proxy creds + identity).

---

## 4. Phases

### Phase 0 — Scaffold *(this commit)*
- [x] Repo init, README, this plan, `.gitignore`, `profiles/` store + example, `Profile` type, package skeleton.

### Phase 1 — App skeleton that launches
- [ ] Wire Next.js (App Router, `output: "export"`) + Electron main + preload; `npm run dev` opens a window.
- [ ] Tailwind set up; base layout + dark theme.
- [ ] Profile store in main (list/read/write/delete `profiles/<id>.json`) over typed IPC.
- [ ] Binary resolver via the `clearcote` SDK (`executablePath`, with a Settings override).
- [ ] **Launch a hardcoded profile** end-to-end (spawn `chrome.exe` with `--fingerprint` + `--user-data-dir`).

### Phase 2 — Full CRUD UI
- [ ] Profile list (cards): name, seed, proxy, tags, last launched; Launch / Edit / Duplicate / Delete.
- [ ] Profile editor form: name, seed (+ "randomize" generator), platform, brand, GPU vendor/renderer, hardwareConcurrency, timezone (IANA picker), acceptLanguage, webrtcIp, geoip toggle, location, proxy (server/user/pass), extraArgs, notes, tags, group.
- [ ] Validation + save; create/duplicate/delete with confirmation.
- [ ] Search + filter by tag/group.

### Phase 3 — Coherence & convenience
- [ ] `geoip` integration (`resolveGeo`) — preview the matched timezone/language/IP before launch.
- [ ] **Egress IP / health check** per profile (open a tiny page or fetch through the proxy; show the public IP + a quick "fingerprint sane?" check).
- [ ] Running-instance indicator + Stop; "launch N windows".
- [ ] Import / export profiles (JSON), with credential-redaction option on export.

### Phase 4 — Polish & ship
- [ ] Settings pane: binary path / auto-download + auto-update toggle, default proxy, theme, profiles dir.
- [ ] Packaging via electron-builder (Windows installer + portable).
- [ ] Profile groups/folders, drag-reorder, keyboard shortcuts.
- [ ] Docs: usage in `README.md`; link from the main project site/roadmap.

### Later / nice-to-have
- Proxy pool + assignment/rotation; bulk operations; profile templates; seeded "persona preview" (show the derived GPU/hardware/screen for a seed); optional automation mode (expose `humanize`/`showCursor`, run a saved script via the SDK).

---

## 5. Conventions

- **TypeScript** everywhere; the IPC contract is a shared typed interface.
- **Security:** `contextIsolation: true`, `nodeIntegration: false`, no `fs`/`child_process` in the renderer; a narrow preload bridge only.
- **No secrets in git:** `profiles/` (real data) is ignored; export redacts proxy passwords by default.
- **Windows-first** (the browser is Windows x64), but keep the launcher path-agnostic for later platforms.
- Commit identity `pim97 <pim97@users.noreply.github.com>`; **never** add a `Co-Authored-By: Claude` trailer.
