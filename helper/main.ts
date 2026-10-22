// Clearcote Helper: lets the web profile manager start the Clearcote browser on this computer.
//
// It is the desktop app without its window: the same profile store and launcher (electron/*.ts),
// reached over http://127.0.0.1 instead of Electron IPC. Run it, keep the window open, and open the
// profile manager in your browser. Everything it does is listed in this window and on its own page.
//
//   node clearcote-helper.js [--port 47821] [--allow-origin http://localhost:3000] [--no-open]

import { spawn } from "node:child_process";
import path from "node:path";
import * as launcher from "../electron/launcher";
import { USER_DATA } from "./userdata";
import { bootstrap, createHandlers } from "../electron/handlers";
import { TokenStore } from "./auth";
import { createServer } from "./server";
import { webPolicy } from "./policy";

declare const __HELPER_VERSION__: string;
const VERSION = typeof __HELPER_VERSION__ === "string" ? __HELPER_VERSION__ : "dev";

/** The ports the web page looks on, in order. */
export const PORTS = [47821, 47822, 47823];

function args(argv: string[]) {
  const out = { port: 0, origins: [] as string[], open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--allow-origin") out.origins.push(String(argv[++i]));
    else if (a === "--no-open") out.open = false;
    else if (a === "--help" || a === "-h") {
      console.log("clearcote-helper [--port N] [--allow-origin ORIGIN]... [--no-open]");
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

async function main() {
  const opt = args(process.argv.slice(2));
  const ports = opt.port ? [opt.port] : PORTS;

  for (const port of ports) {
    if (await helperOn(port)) {
      log(`A Clearcote helper is already running at http://127.0.0.1:${port}/ — this one is not needed.`);
      if (opt.open) await openWithOs(`http://127.0.0.1:${port}/`);
      return;
    }
  }

  console.log(`Clearcote Helper ${VERSION}`);
  console.log(`Profiles and settings: ${USER_DATA}`);
  console.log("Keep this window open while you use the web profile manager. Closing it closes your browsers.\n");

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

  let started: ReturnType<typeof createServer> | null = null;
  for (const port of ports) {
    const s = createServer({
      port,
      version: VERSION,
      handlers,
      tokens,
      extraOrigins: opt.origins,
      log,
      onPairRequest: (p, url) => {
        log(`Pairing request from ${p.origin}. Code ${p.code}. Approve it at ${url}`);
        if (opt.open) void openWithOs(url);
      },
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

  launcher.browserEvents.on("exited", (ev) => {
    log(`Browser for profile ${ev.id} closed.`);
    broadcast("browser:exited", ev);
  });
  cloud.on("changed", (list) => broadcast("cloud:changed", list));
  cloud.on("ended", (ev) => broadcast("cloud:ended", ev));
  void cloud.restore();

  // Closing the window or Ctrl+C: close the browsers properly so each licence slot is checked back in.
  let quitting = false;
  const quit = async (sig: string) => {
    if (quitting) return;
    quitting = true;
    log(`${sig}: closing browsers…`);
    launcher.setQuitting(true);
    await Promise.race([launcher.stopAll({ timeoutMs: 4000 }), new Promise((r) => setTimeout(r, 4500))]);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(sig, () => void quit(sig));
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
