# `profiles/`

Runtime store for saved Clearcote profiles.

**Not committed to git** (except this `README.md`, `.gitkeep`, and `example.profile.json`) — profiles can contain proxy credentials and per-identity browser storage. See the root `.gitignore`.

Each profile is:

- `profiles/<id>.json` — the profile config (shape: [`../src/types/profile.ts`](../src/types/profile.ts); example: [`example.profile.json`](example.profile.json))
- `profiles/<id>/userdata/` — that profile's persistent Chromium `--user-data-dir` (cookies, logins, storage), so sessions survive across launches.

The app reads/writes these files via the Electron main process; you normally don't edit them by hand. Copy `example.profile.json` if you want to seed one manually.
