// The web version's bridge: the same ClearcoteApi the desktop app gets from its preload, carried
// over http://127.0.0.1 to the Clearcote Helper (helper/server.ts) instead of Electron IPC.
//
// The page finds the helper on one of its ports, pairs once (the person approves on the helper's
// own page), and keeps the token in this browser's localStorage. Every call is one POST /v1/rpc;
// progress and "a browser closed" arrive on one long-lived /v1/events stream.

import type { ClearcoteApi } from "./ipc";

/** helper/main.ts PORTS. */
export const HELPER_PORTS = [47821, 47822, 47823];
const STORE_KEY = "clearcote.helper";

export interface HelperConn {
  port: number;
  token: string;
}
export interface Probe {
  port: number;
  version: string;
  paired: boolean;
}
export interface PairRequest {
  id: string;
  code: string;
  secret: string;
  approveUrl: string;
}

type Listener = (data: unknown) => void;

function loadConn(): HelperConn | null {
  try {
    const c = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    return c && typeof c.port === "number" && typeof c.token === "string" ? c : null;
  } catch {
    return null;
  }
}
function saveConn(c: HelperConn | null) {
  try {
    if (c) localStorage.setItem(STORE_KEY, JSON.stringify(c));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* private mode: paired for this tab only */
  }
}

const base = (port: number) => `http://127.0.0.1:${port}`;

/** Connection state, shared by the bridge and the connect screen (HelperGate). */
export const helper = {
  conn: null as HelperConn | null,
  /** The app talks to the helper (true) or to the preview (false). HelperGate decides. */
  live: false,
  /** Set on pairing to why the person connected; the app reads it once to carry on from there. */
  justPaired: null as string | null,
  /** Called when the helper stops answering or forgets this page; the connect screen comes back. */
  onLost: null as null | ((why: "gone" | "unpaired") => void),

  load() {
    this.conn = loadConn();
    return this.conn;
  },

  /** Look for a helper. With a saved token, also whether it still knows this page. */
  async probe(): Promise<Probe | null> {
    const saved = this.conn ?? loadConn();
    const order = saved ? [saved.port, ...HELPER_PORTS.filter((p) => p !== saved.port)] : HELPER_PORTS;
    for (const port of order) {
      try {
        const headers: Record<string, string> = {};
        if (saved?.port === port) headers.Authorization = `Bearer ${saved.token}`;
        const r = await fetch(`${base(port)}/v1/hello`, { headers, signal: AbortSignal.timeout(2500) });
        if (!r.ok) continue;
        const j = await r.json();
        if (j?.app !== "clearcote-helper") continue;
        return { port, version: String(j.version || ""), paired: !!j.paired };
      } catch {
        /* nothing there, or the browser blocked it */
      }
    }
    return null;
  },

  /** `code`: the one this page showed for `clearcote connect CODE`; a helper started with it pairs at once. */
  async startPairing(port: number, name: string, code?: string): Promise<PairRequest> {
    const r = await fetch(`${base(port)}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(code ? { name, code } : { name }),
    });
    if (!r.ok) throw new Error(`The helper refused (${r.status}).`);
    return r.json();
  },

  /** One look at a pairing request; on approval the token is saved and the bridge is live. */
  async pairStatus(port: number, req: PairRequest): Promise<"pending" | "approved" | "denied" | "expired"> {
    const r = await fetch(`${base(port)}/v1/pair/${encodeURIComponent(req.id)}`, {
      headers: { "X-Pair-Secret": req.secret },
    });
    if (!r.ok) return "expired";
    const j = await r.json();
    if (j.status === "approved" && j.token) {
      this.conn = { port, token: j.token };
      saveConn(this.conn);
    }
    return j.status;
  },

  /** Use this port with the saved token (after a probe said it is still paired). */
  use(port: number) {
    const saved = this.conn ?? loadConn();
    if (!saved) return;
    this.conn = { port, token: saved.token };
    saveConn(this.conn);
    events.start();
  },

  forget() {
    this.conn = null;
    this.live = false;
    saveConn(null);
    events.stop();
  },
};

/** helper/auth.ts CODE_ALPHABET: no 0/O, 1/I/L. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A code for `clearcote connect CODE`, like "4F7-K2Q". Made here: the helper is not running yet. */
export function connectCode(): string {
  const r = new Uint32Array(6);
  crypto.getRandomValues(r);
  const c = Array.from(r, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 3)}-${c.slice(3)}`;
}

/** Why this page was just paired, once (null afterwards, and when it was not). */
export function takeJustPaired(): string | null {
  const w = helper.justPaired;
  helper.justPaired = null;
  return w;
}

// ── RPC ───────────────────────────────────────────────────────────────────────

async function rpc<T>(channel: string, ...args: unknown[]): Promise<T> {
  const c = helper.conn;
  if (!c) throw new Error("Not connected to the Clearcote helper.");
  let r: Response;
  try {
    r = await fetch(`${base(c.port)}/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.token}` },
      body: JSON.stringify({ channel, args }),
    });
  } catch {
    helper.onLost?.("gone");
    throw new Error("The Clearcote helper is not answering. Is its window still open?");
  }
  if (r.status === 401) {
    helper.forget();
    helper.onLost?.("unpaired");
    throw new Error("This page is no longer paired with the helper.");
  }
  const j = await r.json().catch(() => null);
  if (!j || !r.ok) throw new Error(j?.error || `The helper answered ${r.status}.`);
  if (!j.ok) throw new Error(j.error || "The helper could not do that.");
  return j.result as T;
}

/** Profiles made in the preview, saved on the computer (ids already taken get new ones). */
export async function importToHelper(list: unknown[]): Promise<number> {
  const r = await rpc<{ ok: boolean; count?: number; error?: string }>("profiles:importData", JSON.stringify(list));
  if (!r.ok) throw new Error(r.error || "The profiles could not be moved.");
  return r.count ?? 0;
}

// ── Events ────────────────────────────────────────────────────────────────────

const listeners = new Map<string, Set<Listener>>();

const events = {
  ctrl: null as AbortController | null,
  start() {
    if (this.ctrl || !helper.conn) return;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    void this.run(ctrl);
  },
  stop() {
    this.ctrl?.abort();
    this.ctrl = null;
  },
  async run(ctrl: AbortController) {
    let delay = 1000;
    while (!ctrl.signal.aborted && helper.conn) {
      try {
        const c = helper.conn;
        const r = await fetch(`${base(c.port)}/v1/events`, {
          headers: { Authorization: `Bearer ${c.token}` },
          signal: ctrl.signal,
        });
        if (r.status === 401) {
          helper.forget();
          helper.onLost?.("unpaired");
          return;
        }
        if (!r.ok || !r.body) throw new Error(String(r.status));
        delay = 1000;
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as { channel: string; data: unknown };
              listeners.get(ev.channel)?.forEach((cb) => cb(ev.data));
            } catch {
              /* a partial or foreign line */
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
      }
      // The stream ended: the helper restarted or closed. Try again, then tell the page.
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 10_000);
      if (!(await helper.probe())) helper.onLost?.("gone");
    }
  },
};

function on<T>(channel: string, cb: (data: T) => void): () => void {
  let set = listeners.get(channel);
  if (!set) listeners.set(channel, (set = new Set()));
  const l = cb as Listener;
  set.add(l);
  return () => set!.delete(l);
}

// ── Files: the page picks and saves them, the helper never sees a path ───────

function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const ALLOWED_EXTERNAL = [/^https:\/\/www\.clearcotelabs\.com\//, /^https:\/\/github\.com\/clearcotelabs\//];

/** The cloud viewer page, next to this one (cloud.html in the static export, /cloud in dev). */
function openCloudViewer(id: string): boolean {
  const page = process.env.NODE_ENV === "production" ? "cloud.html" : "/cloud";
  return !!window.open(`${page}?id=${encodeURIComponent(id)}`, `cc-cloud-${id}`);
}

// ── The API ───────────────────────────────────────────────────────────────────

export function buildHelperApi(): ClearcoteApi {
  helper.load();
  const call =
    <T,>(channel: string) =>
    (...args: unknown[]) =>
      rpc<T>(channel, ...args);

  return {
    profiles: {
      list: call("profiles:list"),
      get: call("profiles:get"),
      save: call("profiles:save"),
      remove: call("profiles:delete"),
      restore: call("profiles:restore"),
      openData: call("profiles:openData"),
      clearCache: call("profiles:clearCache"),
      renameGroup: call("profiles:renameGroup"),
    },
    checkProfileGeo: call("geo:checkProfile"),
    onBrowserExited: (cb) => on("browser:exited", cb),
    storage: {
      plan: call("storage:plan"),
      prune: call("storage:prune"),
      temp: call("storage:temp"),
      cleanTemp: call("storage:cleanTemp"),
      profileSizes: call("storage:profileSizes"),
      prefetch: call("build:prefetch"),
      onPrefetchProgress: (cb) => on("prefetch:progress", cb),
    },
    openExternal: async (url) => {
      if (!ALLOWED_EXTERNAL.some((re) => re.test(String(url)))) return false;
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    },
    launchTarget: call("launchTarget"),
    launch: call("launch"),
    stop: call("stop"),
    running: call("running"),
    cloud: {
      list: call("cloud:list"),
      start: async (p) => {
        const r = await rpc<Awaited<ReturnType<ClearcoteApi["cloud"]["start"]>>>("cloud:start", p);
        if (r.ok) openCloudViewer(p.id);
        return r;
      },
      stop: call("cloud:stop"),
      open: async (id) => {
        const list = await rpc<{ profileId: string }[]>("cloud:list");
        return list.some((s) => s.profileId === id) && openCloudViewer(id);
      },
      viewUrl: call("cloud:viewUrl"),
      account: call("cloud:account"),
      onChanged: (cb) => on("cloud:changed", cb),
      onEnded: (cb) => on("cloud:ended", cb),
    },
    hostGpu: call("host:gpu"),
    listVersions: call("versions:list"),
    listRevisions: call("versions:revisions"),
    onDownloadProgress: (cb) => on("download:progress", cb),
    settings: { get: call("settings:get"), set: call("settings:set") },
    license: { check: call("license:check"), loginStart: call("license:loginStart"), loginPoll: call("license:loginPoll") },
    cache: { list: call("cache:list"), remove: call("cache:remove") },
    // The web version is always the newest; the helper has its own downloads.
    update: {
      check: async () => null,
      download: async () => ({ ok: false, error: "Updates come with the web page." }) as never,
      run: async () => {},
      reveal: async () => {},
      openReleases: async (url) => void window.open(url, "_blank", "noopener,noreferrer"),
    },
    onUpdateProgress: () => () => {},
    resolveBinary: call("resolveBinary"),
    // Which program the helper runs is never a web page's choice (helper/policy.ts).
    pickBinary: async () => {
      window.alert(
        "The web version always uses the verified Clearcote download. To run your own browser build, choose it in the desktop app on this computer: the helper uses the same setting.",
      );
      return null;
    },
    geoCheck: call("geo:check"),
    exportProfiles: async (opts) => {
      const r = await rpc<{ ok: boolean; filename?: string; count?: number; json?: string }>("profiles:exportData", opts);
      if (!r.ok || !r.json) return { ok: false };
      saveFile(r.filename || "clearcote-profiles.json", r.json);
      return { ok: true, count: r.count };
    },
    importProfiles: async () => {
      const f = await pickFile(".json,application/json");
      if (!f) return { ok: false };
      return rpc("profiles:importData", await f.text());
    },
    fp: {
      import: async () => {
        const f = await pickFile(".json,application/json");
        if (!f) return { ok: false };
        return rpc("fp:importData", f.name, await f.text());
      },
      library: call("fp:library"),
      use: call("fp:use"),
    },
  };
}
