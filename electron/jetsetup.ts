// Getting Jet ready to run tasks, without a terminal: find a Python, find (or install) Jet, check the model key.
// The Run a task dialog and Settings → Tasks show the three as a checklist (src/components/JetSetup.tsx).
//
// - Jet is found by starting a worker and reading its first line ({"type":"ready","version":...}), the same
//   way a run starts it, then closing its stdin (a worker with no request exits).
// - When `clearcote-jet` is not on PATH (pip put it in a user Scripts folder), the Python that has Jet is used
//   as `"<python>" -m clearcote_jet.cli`, and that becomes the saved command.
// - Install is `pip install -U <zip of Jet's main>`: no git needed on this PC.
// - The key check sends an empty request to the model API: 401 is a bad key, 422 (the request is incomplete)
//   means the key was accepted. Nothing is charged for either.
// Nothing here touches Electron: the desktop app and the web helper share it.

import { spawn } from "node:child_process";
import type { Settings } from "./types";
import { MIN_JET, parseCommandLine, workerCommand } from "./jetsync";

export const JET_ZIP = "https://github.com/clearcotelabs/clearcote-jet/archive/refs/heads/main.zip";
export const KEY_URL = "https://console.typesafe.ai";
export const PYTHON_URL = "https://www.python.org/downloads/";
const DECIDE_URL = "https://api.typesafe.ai/v1/systemone";
const MIN_PYTHON = [3, 10] as const;

export interface PythonFound {
  /** How to start it, e.g. ["py", "-3"]. */
  cmd: string[];
  /** Full path of the interpreter (sys.executable). */
  exe: string;
  version: string;
}

export type JetState =
  | { ok: true; version: string; command: string }
  | { ok: false; reason: "missing" | "old" | "error"; version?: string; detail?: string };

export type KeyState = { ok: true; source: "settings" | "environment" } | { ok: false; reason: "missing" | "rejected" | "error"; detail?: string };

export interface JetStatus {
  python: PythonFound | null;
  jet: JetState;
  key: KeyState;
  /** Jet and the key are both good: a task can run. */
  ready: boolean;
  /** A command that works although the saved one does not (it is saved when the status is read). */
  fixedCommand?: string;
}

export interface Exec {
  (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }): Promise<{ code: number | null; out: string; err: string; spawnError?: string }>;
}

/** Run a program to completion and collect its output. A missing program resolves with spawnError, never throws. */
export const execFile: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: { code: number | null; spawnError?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ out, err, ...r });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { env: opts.env ?? process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return finish({ code: null, spawnError: (e as { code?: string })?.code || String(e) });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, spawnError: "timeout" });
    }, opts.timeoutMs ?? 20_000);
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (err += d));
    child.on("error", (e) => finish({ code: null, spawnError: (e as { code?: string }).code || e.message }));
    child.on("close", (code) => finish({ code }));
    child.stdin?.end(opts.input ?? "");
  });

function versionAtLeast(v: string, min: readonly number[]): boolean {
  const parts = v.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    if ((parts[i] ?? 0) !== min[i]) return (parts[i] ?? 0) > min[i];
  }
  return true;
}

/** The Pythons to try, best first. On Windows `python` may be the Store's placeholder, which prints nothing. */
export function pythonCandidates(platform = process.platform): string[][] {
  return platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
}

/** The first Python 3.10+ on this PC, or null. */
export async function findPython(exec: Exec = execFile, platform = process.platform): Promise<PythonFound | null> {
  for (const cmd of pythonCandidates(platform)) {
    const r = await exec(cmd[0], [...cmd.slice(1), "-c", "import sys;print(sys.executable);print('%d.%d.%d'%sys.version_info[:3])"], { timeoutMs: 15_000 });
    if (r.code !== 0) continue;
    const [exe, version] = r.out.trim().split(/\r?\n/).map((s) => s.trim());
    if (exe && version && versionAtLeast(version, MIN_PYTHON)) return { cmd, exe, version };
  }
  return null;
}

/** Start a worker with this command, read its ready line, and let it go. */
export async function probeJet(command: string[], exec: Exec = execFile, env: NodeJS.ProcessEnv = process.env): Promise<JetState> {
  const [cmd, ...rest] = command;
  const r = await exec(cmd, [...rest, "worker"], { env: { ...env, PYTHONIOENCODING: "utf-8" }, timeoutMs: 30_000 });
  if (r.spawnError === "ENOENT") return { ok: false, reason: "missing" };
  if (/invalid choice: '?worker'?/.test(r.err)) return { ok: false, reason: "old", detail: `needs ${MIN_JET} or newer` };
  if (/No module named '?clearcote_jet/.test(r.err)) return { ok: false, reason: "missing" };
  for (const line of r.out.split(/\r?\n/)) {
    try {
      const ev = JSON.parse(line);
      if (ev?.type === "ready" && typeof ev.version === "string") {
        return versionAtLeast(ev.version, MIN_JET.split(".").map(Number))
          ? { ok: true, version: ev.version, command: command.map(quote).join(" ") }
          : { ok: false, reason: "old", version: ev.version, detail: `needs ${MIN_JET} or newer` };
      }
    } catch {
      /* not a JSON line */
    }
  }
  const tail = (r.err || r.out || r.spawnError || "").trim().split(/\r?\n/).slice(-2).join(" ");
  return { ok: false, reason: "error", detail: tail.slice(0, 300) || "Jet did not answer." };
}

function quote(s: string): string {
  return /[\s"]/.test(s) ? `"${s}"` : s;
}

/** Is this model key accepted? Checks the saved key when none is given, then TYPESAFE_API_KEY. */
export async function checkKey(key: string | undefined, fetcher: typeof fetch = fetch): Promise<KeyState> {
  const source: "settings" | "environment" = key?.trim() ? "settings" : "environment";
  const k = key?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (!k) return { ok: false, reason: "missing" };
  try {
    const r = await fetcher(DECIDE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: "rejected" };
    if (r.status === 422 || r.ok) return { ok: true, source };
    return { ok: false, reason: "error", detail: `The model service answered HTTP ${r.status}.` };
  } catch (e) {
    return { ok: false, reason: "error", detail: `Could not reach the model service (${(e as Error)?.name || "network"}).` };
  }
}

/** Python -m form of the Jet command for this interpreter. */
export function moduleCommand(py: PythonFound): string[] {
  return [py.exe, "-m", "clearcote_jet.cli"];
}

/** Everything the checklist shows. When the saved command fails but Jet is in a Python we found, that
 *  Python's `-m clearcote_jet.cli` is returned as fixedCommand. */
export async function jetStatus(s: Pick<Settings, "jetCommand" | "jetApiKey">, deps: { exec?: Exec; fetcher?: typeof fetch; platform?: NodeJS.Platform } = {}): Promise<JetStatus> {
  const exec = deps.exec ?? execFile;
  const [keyP, pyP] = [checkKey(s.jetApiKey, deps.fetcher), findPython(exec, deps.platform)];
  const [cmd, args] = workerCommand(s);
  let jet = await probeJet([cmd, ...args.slice(0, -1)], exec);
  const python = await pyP;
  let fixedCommand: string | undefined;
  if (!jet.ok && python) {
    const viaModule = await probeJet(moduleCommand(python), exec);
    if (viaModule.ok || (viaModule.reason === "old" && jet.reason === "missing")) {
      jet = viaModule;
      if (viaModule.ok) fixedCommand = viaModule.command;
    }
  }
  const key = await keyP;
  return { python, jet, key, ready: jet.ok && key.ok, fixedCommand };
}

/** pip install (or update) Jet into this Python. Resolves with the last lines of pip's output on failure. */
export async function installJet(py: PythonFound, exec: Exec = execFile): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await exec(py.cmd[0], [...py.cmd.slice(1), "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", JET_ZIP], {
    timeoutMs: 10 * 60_000,
  });
  if (r.code === 0) return { ok: true };
  const text = `${r.err}\n${r.out}`;
  if (/No module named pip/.test(text)) return { ok: false, error: "This Python has no pip. Reinstall Python from python.org with pip included." };
  if (r.spawnError === "timeout") return { ok: false, error: "The install took longer than 10 minutes and was stopped. Check your internet connection and try again." };
  const tail = text.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-4).join("\n");
  return { ok: false, error: tail || `pip exited with code ${r.code}.` };
}

/** True when the user typed a command that is not the module form we would set (so we never overwrite it). */
export function isCustomCommand(saved: string | undefined): boolean {
  if (!saved?.trim()) return false;
  const parts = parseCommandLine(saved);
  return !(parts.length === 3 && parts[1] === "-m" && parts[2] === "clearcote_jet.cli");
}

