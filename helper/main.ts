// Clearcote Helper: lets the web profile manager start the Clearcote browser on this computer.
//
// It is the desktop app without its window: the same profile store and launcher (electron/*.ts),
// reached over http://127.0.0.1 instead of Electron IPC. Run it and open the profile manager in your
// browser. Everything it does is listed in its console window (or helper-log.txt) and on its own page.
//
//   node clearcote-helper.js [--port 47821] [--allow-origin http://localhost:3000] [--no-open] [--pair-code 4F7-K2Q] [--tray]
//
// --tray (Windows; what "Clearcote Helper.cmd" passes): run without a console window, with an icon in
// the notification area instead. See tray.ts.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as launcher from "../electron/launcher";
import { USER_DATA } from "./userdata";
import { bootstrap, createHandlers, getSyncManager } from "../electron/handlers";
import { extensionEvents } from "../electron/extensions";
import { TokenStore } from "./auth";
import { createServer } from "./server";
import { webPolicy } from "./policy";
import { backgroundArgs, LOG_FILE, newTrayToken, TRAY_SCRIPT, TRAY_TOKEN_ENV, trayCommand, trayTooltip } from "./tray";

declare const __HELPER_VERSION__: string;
const VERSION = typeof __HELPER_VERSION__ === "string" ? __HELPER_VERSION__ : "dev";

/** The ports the web page looks on, in order. */
export const PORTS = [47821, 47822, 47823];

function args(argv: string[]) {
  const out = {
    port: 0,
    origins: [] as string[],
    open: true,
    pairCode: process.env.CLEARCOTE_HELPER_PAIR_CODE || "",
    tray: false,
    background: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--allow-origin") out.origins.push(String(argv[++i]));
    else if (a === "--no-open") out.open = false;
    else if (a === "--pair-code") out.pairCode = String(argv[++i] || "");
    else if (a === "--tray") out.tray = true;
    else if (a === "--background") out.background = true;
    else if (a === "--help" || a === "-h") {
      console.log("clearcote-helper [--port N] [--allow-origin ORIGIN]... [--no-open] [--pair-code CODE] [--tray]");
      process.exit(0);
    }
  }
  return out;
}

/** Open a URL or folder the way double-clicking it would. No shell: the target is one argument. */
function openWithOs(target: string): Promise<string> {
  const [cmd, a] =
    process.platform === "win32" ? ["explorer.exe", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
  return new Promise((resolve) => {
    try {
      const p = spawn(cmd, a as string[], { stdio: "ignore", detached: true, windowsHide: true });
      p.on("error", (e) => resolve(String(e.message)));
      p.unref();
      setTimeout(() => resolve(""), 200);
    } catch (e) {
      resolve(String((e as Error).message));
    }
  });
}

const stamp = () => new Date().toLocaleTimeString();
const log = (line: string) => console.log(`[${stamp()}] ${line}`);

/** Is a helper already answering on this port? */
async function helperOn(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.text()).includes("Clearcote Helper");
  } catch {
    return false;
  }
}

/** The tray script in this download, or null (not Windows, or run from source without one). */
function trayScript(): string | null {
  if (process.platform !== "win32") return null;
  const p = path.join(__dirname, TRAY_SCRIPT);
  return fs.existsSync(p) ? p : null;
}

/**
 * --tray, in the console window: start the helper again without a console (its output into
 * helper-log.txt), wait until it listens, and return, so the window closes. False when that copy
 * did not come up: the caller exits with an error and the window stays open (the .cmd pauses).
 */
async function startInBackground(argv: string[]): Promise<boolean> {
  fs.mkdirSync(USER_DATA, { recursive: true });
  const logPath = path.join(USER_DATA, LOG_FILE);
  const fd = fs.openSync(logPath, "w");
  let child: ChildProcess;
  try {
    // detached: no console at all (not a hidden one), and it outlives this window.
    child = spawn(process.execPath, [process.argv[1], ...backgroundArgs(argv)], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd, "ipc"],
    });
  } finally {
    fs.closeSync(fd);
  }
  const url = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => done(null), 30_000);
    function done(v: string | null) {
      clearTimeout(timer);
      resolve(v);
    }
    child.on("message", (m: { listening?: string }) => {
      if (m?.listening) done(m.listening);
    });
    child.on("exit", () => done(null));
    child.on("error", () => done(null));
  });
  if (!url) {
    try {
      process.stdout.write(fs.readFileSync(logPath, "utf8"));
    } catch {
      /* no log */
    }
    log(`The helper did not start in the background. Its output is above and in ${logPath}.`);
    log(`"Clearcote Helper (console).cmd" runs it in a window instead.`);
    return false;
  }
  if (child.connected) child.disconnect();
  child.unref();
  log(`Clearcote Helper is running at ${url}`);
  log("Its icon is in the notification area (next to the clock; maybe behind the ^ arrow).");
  log("Right-click it to open its page or to quit. This window closes now.");
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = args(argv);
  const ports = opt.port ? [opt.port] : PORTS;
  const script = opt.tray || opt.background ? trayScript() : null;
  if (opt.tray && !script && process.platform === "win32") {
    log("No tray script next to this program (tray\\clearcote-tray.ps1): running in this window instead.");
  }

  for (const port of ports) {
    if (await helperOn(port)) {
      log(`A Clearcote helper is already running at http://127.0.0.1:${port}/ — this one is not needed.`);
      if (opt.pairCode) log("That helper does not know your code: approve the pairing on the page it opens instead.");
      if (opt.open) await openWithOs(`http://127.0.0.1:${port}/`);
      return;
    }
  }

  if (opt.tray && !opt.background && script) {
    process.exitCode = (await startInBackground(argv)) ? 0 : 1;
    return;
  }
  const background = opt.background && !!script;

  console.log(`Clearcote Helper ${VERSION}`);
  console.log(`Profiles and settings: ${USER_DATA}`);
  if (background) console.log("Running without a window, with an icon in the notification area. Quit it from there.\n");
  else console.log("Keep this window open while you use the web profile manager. Closing it closes your browsers.\n");

  const cloud = bootstrap(path.join(USER_DATA, "cloud-sessions.json"));
  const tokens = new TokenStore(path.join(USER_DATA, "helper-paired-sites.json"));
  // The shared handlers, with what a web page may not do taken out (policy.ts).
  const handlers = webPolicy(createHandlers({
    cloud: () => cloud,
    changed: () => {},
    // The web page opens a cloud profile's viewer in a tab of its own.
    openViewer: () => false,
    openPath: (dir) => openWithOs(dir),
    openExternal: (url) => void openWithOs(url),
  }));
  // No desktop app here to update: the web version reports the helper's own version instead.
  handlers["update:check"] = () => null;
  handlers["helper:info"] = () => ({ version: VERSION, platform: process.platform, arch: process.arch, dataDir: USER_DATA });

  const trayToken = background ? newTrayToken() : "";
  // Set below; the tray's Quit can only arrive once the server is up, after that.
  let quit: (why: string) => Promise<void> = async () => {};

  let started: ReturnType<typeof createServer> | null = null;
  for (const port of ports) {
    const s = createServer({
      port,
      version: VERSION,
      handlers,
      tokens,
      pairCode: opt.pairCode || undefined,
      extraOrigins: opt.origins,
      log,
      onPairRequest: (p, url) => {
        log(`Pairing request from ${p.origin}. Code ${p.code}. Approve it at ${url}`);
        if (opt.open) void openWithOs(url);
      },
      tray: background
        ? {
            token: trayToken,
            status: () => {
              const browsers = launcher.listRunning().length;
              return { tooltip: trayTooltip(browsers), browsers };
            },
            quit: () => void quit("Quit (tray icon)"),
          }
        : undefined,
    });
    const ok = await new Promise<boolean>((resolve) => {
      s.server.once("error", () => resolve(false));
      s.server.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (ok) {
      started = s;
      break;
    }
    log(`Port ${port} is taken by another program; trying the next one.`);
  }
  if (!started) {
    log(`Could not listen on ${ports.join(", ")}. Close whatever uses them, or start with --port.`);
    process.exitCode = 1;
    return;
  }
  const { broadcast, url } = started;
  log(`Listening on ${url}  (open it to see paired sites and activity)`);
  if (opt.pairCode) log(`Waiting for the web page that shows the code ${opt.pairCode.toUpperCase()}. It connects by itself.`);

  launcher.browserEvents.on("exited", (ev) => {
    log(`Browser for profile ${ev.id} closed.`);
    broadcast("browser:exited", ev);
  });
  cloud.on("changed", (list) => broadcast("cloud:changed", list));
  cloud.on("ended", (ev) => broadcast("cloud:ended", ev));
  getSyncManager({ cloud: () => cloud }).on("changed", (runs) => broadcast("sync:changed", runs));
  getSyncManager({ cloud: () => cloud }).on("tasksChanged", () => broadcast("tasks:changed", null));
  extensionEvents.on("changed", () => broadcast("extensions:changed", null));
  void cloud.restore();

  // Closing the window, Ctrl+C or the tray's Quit: close the browsers properly so each licence slot
  // is checked back in.
  let quitting = false;
  let trayChild: ChildProcess | null = null;
  quit = async (why: string) => {
    if (quitting) return;
    quitting = true;
    log(`${why}: closing browsers…`);
    launcher.setQuitting(true);
    await getSyncManager({ cloud: () => cloud }).shutdown();
    await Promise.race([launcher.stopAll({ timeoutMs: 4000 }), new Promise((r) => setTimeout(r, 4500))]);
    if (trayChild && trayChild.exitCode === null) trayChild.kill();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => void quit(sig));

  if (background && script) {
    const cmd = trayCommand({ script, port: Number(new URL(url).port), helperPid: process.pid, systemRoot: process.env.SystemRoot });
    const child = spawn(cmd.file, cmd.args, {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, [TRAY_TOKEN_ENV]: trayToken },
    });
    trayChild = child;
    // Without its icon nobody could quit this helper, so it goes when the icon goes.
    child.on("exit", (code) => void quit(`The tray icon closed (exit ${code ?? "?"})`));
    child.on("error", (e) => void quit(`The tray icon could not start (${e.message})`));
    log(`Tray icon started (Windows PowerShell, PID ${child.pid ?? "?"}).`);
  }
  // The console copy that started this one (--tray) waits for this, then closes its window.
  if (process.send) {
    process.send({ listening: url });
    process.disconnect?.();
  }
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
