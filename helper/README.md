# Clearcote Helper

The helper lets the **web** version of the Clearcote Profile Manager start the Clearcote browser on
your computer. A web page cannot start programs by itself. The helper is the small piece that can.

It is the desktop app without its window. The profile store, the launcher, the licence checks and the
cloud sessions are the same code as the desktop app (`electron/*.ts`, shared through
`electron/handlers.ts`). Only the front door is different: the desktop app talks to its window over
Electron IPC, and the helper talks to the web page over `http://127.0.0.1`.

Everything here is open source (BSD-3-Clause, see [LICENSE](../LICENSE)). The download is built by a
public GitHub workflow, and you can rebuild it yourself and get the same bytes. See
[Check a download](#check-a-download).

## Using it

1. Download the helper for your system from the
   [releases](https://github.com/clearcotelabs/clearcote-profile-manager/releases) (tags `helper-v…`).
2. Unpack it and start it:
   - Windows: double-click `Clearcote Helper.cmd`.
   - macOS: double-click `Clearcote Helper.command`. The first time, macOS may block it: right-click
     it and choose **Open**.
   - Linux: run `./clearcote-helper.sh`.
3. A console window opens. Keep it open while you use the profile manager. Closing it closes your
   browsers (each one properly, so its licence slot is returned).
4. Open the web profile manager. The first time, it asks to pair with the helper (below).

Nothing is installed. The folder is the whole program. To remove it, delete the folder.

Profiles and settings live in the same folder as the desktop app's, so both see the same profiles:

| OS | Folder |
| --- | --- |
| Windows | `%APPDATA%\Clearcote Profile Manager` |
| macOS | `~/Library/Application Support/Clearcote Profile Manager` |
| Linux | `$XDG_CONFIG_HOME/Clearcote Profile Manager` (default `~/.config/…`) |

Set `CLEARCOTE_PM_DATA_DIR` to use another folder.

### Pairing

The first time a web page wants to use the helper, it has to be paired:

1. The page asks the helper to pair. The page shows a code like `4F7-K2Q`.
2. The helper opens its own approval page in your default browser, at
   `http://127.0.0.1:47821/pair/…`. It shows the site that asked and the same code.
3. If you opened the profile manager yourself and the codes match, press **Codes match: approve**.
4. The page receives a token and remembers it. It does not have to pair again.

A pairing request expires after 2 minutes. Each site has at most one open request.

### The helper's own page

Open `http://127.0.0.1:47821/` at any time. It shows:

- the sites you paired, when, and when each last used the helper, with a **Remove** button;
- requests waiting for your approval;
- recent activity: every call a site made that changes something (launch, stop, save, delete,
  settings…), with the time and the site. Calls that only read are not listed.

The console window prints the same activity as it happens.

### Chrome's local network prompt

Recent Chrome versions ask before a public website may talk to a program on your own computer. The
first time the profile manager reaches the helper, Chrome shows a prompt about connecting to devices
on your local network. Choose **Allow**. If you blocked it, change it in the site's settings (the icon
left of the address bar).

### Options

```
clearcote-helper [--port N] [--allow-origin ORIGIN]... [--no-open]
```

- `--port N` listen on this port only. By default the helper uses the first free one of 47821, 47822,
  47823, and the web page looks on those.
- `--allow-origin ORIGIN` also let this site pair, for example `http://localhost:3000` when you run the
  web UI yourself. Repeat it for more. `CLEARCOTE_HELPER_ORIGINS` (comma-separated) does the same.
- `--no-open` do not open the approval page in your browser. Open the address printed in the console
  instead.

If a helper is already running, starting a second one just opens the first one's page and exits.

## Security model

The helper listens on `127.0.0.1` only. Nothing outside your computer can reach it.

Every request from a web page passes three checks (`helper/server.ts`, `helper/auth.ts`):

1. **Host.** The request must be addressed to `127.0.0.1`, `localhost` or `[::1]` on the helper's port.
   A website that points its own domain name at 127.0.0.1 (DNS rebinding) sends its own name here and
   is refused.
2. **Origin.** The page must come from an allowed site. Browsers set the `Origin` header themselves; a
   page cannot fake it. The allowed sites are `DEFAULT_ORIGINS` in `helper/auth.ts`:
   `https://app.clearcotelabs.com`, `https://www.clearcotelabs.com` and `https://clearcotelabs.github.io`,
   plus any you add with `--allow-origin`. Any other site gets no CORS headers, so its page cannot read
   an answer, and the helper does nothing. Every write is a JSON `POST`, which makes the browser ask
   first (a CORS preflight), so the origin check runs before anything happens.
3. **Token.** Everything except "is a helper here" and pairing needs a token, and the token only works
   for the site that paired it.

Pairing needs a person at the keyboard. The approval page lives on the helper itself
(`http://127.0.0.1:<port>`). A website cannot read it, frame it (`frame-ancestors 'none'`,
`X-Frame-Options: DENY`) or submit it: its forms only accept posts whose `Origin` is the helper's own
page and that carry a secret made fresh each time the helper starts. The page has no scripts and loads
nothing from anywhere (`default-src 'none'`).

Tokens:

- are 32 random bytes, handed to the page once;
- are stored only as a SHA-256 hash, with the site that paired them, in `helper-paired-sites.json` in
  the data folder (file mode 600 where the OS supports it);
- can be removed on the helper's page, which ends that site's access at once.

### What a paired site can do

A paired site can list, create, change and delete profiles; launch and stop their browsers; run them
in the cloud; change the app's settings; check the licence; manage downloaded browser builds; import
and export profiles.

What the desktop app's own window may do but a web page may not (`helper/policy.ts`):

- choose which browser program runs: `binaryPath` stays as set on this computer, and so do the
  addresses the licence key and cloud API key are sent to (`licenseApiBase`, `cloudApiBase`);
- pass Chrome switches that run programs or take a file or folder (`--renderer-cmd-prefix`,
  `--gpu-launcher`, `--log-file=…`, `--no-sandbox`, …). Switches you set in the desktop app stay;
- move a profile's data to another folder (`userDataDir`) or load a fingerprint file by path;
- launch anything but the profile as saved on this computer;
- read your licence key or cloud API key back: the page sees them masked. It can replace them.

Exporting with "include secrets" ticked gives the page that profile's proxy passwords and encryption
key, because you asked for them in a file.

The helper has no call that reads arbitrary files or runs an arbitrary command. It opens links only to
`www.clearcotelabs.com` and `github.com/clearcotelabs`, and downloads fingerprint profiles only from
the `clearcotelabs/clearcote-profiles` repository.

Pair only sites you opened yourself, and remove ones you no longer use.

## What is in a download

| File | What it is |
| --- | --- |
| `lib/clearcote-helper.js` | The helper's whole program: this repo's `helper/` and `electron/` sources, bundled by esbuild (version pinned in `package-lock.json`). **Not minified**, so you can read it. Its first lines name the commit it was built from. |
| `runtime/node` or `runtime/node.exe` | The official Node.js binary, byte for byte as nodejs.org ships it. |
| `runtime/NODE-LICENSE.txt` | Node.js's licence. |
| `Clearcote Helper.cmd` / `.command` / `clearcote-helper.sh` | Starts `runtime/node` with `lib/clearcote-helper.js`. Read it: it is a few lines. |
| `README.txt`, `LICENSE.txt`, `package.json` | What it is, the licence, and its version. |
| `MANIFEST.sha256` | The SHA-256 of every file above. |

The Node.js version and the SHA-256 of each Node.js archive are pinned in
[`node-runtime.json`](node-runtime.json). The build refuses an archive that does not match. Compare
those hashes with `https://nodejs.org/dist/v<version>/SHASUMS256.txt`.

## Check a download

The build is reproducible: the same commit and the same `package-lock.json` give the same bytes, on
any OS. File times come from the commit (`SOURCE_DATE_EPOCH`), files are in a fixed order, and no
absolute paths end up in the output.

**Rebuild and compare, file by file:**

```bash
git clone https://github.com/clearcotelabs/clearcote-profile-manager
cd clearcote-profile-manager
git checkout helper-v<version>
npm ci
npm run helper:verify -- path/to/clearcote-helper-<version>-<platform>.zip
```

It rebuilds the helper for that platform and prints `same` or `DIFFERENT` for every file, plus any file
in the download that the build does not make. On Windows, clone with `git config --global core.autocrlf
false` first: Git otherwise rewrites line endings in the sources, and the rebuilt bundle differs for that
reason alone.

**Check that GitHub's workflow built it** (needs the [GitHub CLI](https://cli.github.com/)):

```bash
gh attestation verify path/to/download --repo clearcotelabs/clearcote-profile-manager
```

Each release also lists the SHA-256 of every download in `SHA256SUMS`.

On every release, the workflow (`.github/workflows/helper-release.yml`) builds on Linux, rebuilds the
same commit on Windows and macOS, and fails if any file differs.

## Run it from source

```bash
npm ci
npm run helper:dev
```

This bundles the helper into `helper-dist/lib/clearcote-helper.js` and starts it with your own Node.js
(24 or newer), allowing `http://localhost:3000` as well, for the web UI's dev server (`npm run next:dev`
with `NEXT_PUBLIC_PM_TARGET=web`).

`npm run helper:build` builds every download into `helper-dist/`; `npm run helper:build -- win-x64`
builds one.

## Known limits

- There is no tray icon. The helper is a console window, and it has to stay open.
- Do not run the desktop app and the helper at the same time. They share the same profiles, and each
  keeps its own list of running browsers, so the same profile could be started twice.
- The downloads are not code-signed by us. On Windows, `runtime/node.exe` is the Node.js project's own
  signed binary; the rest are text files. On macOS, the first start needs right-click, **Open**.
- Safari may refuse to let a public website reach `http://127.0.0.1`; it has not been tested. Chrome, Edge,
  Brave and Firefox allow it.
