// The cloud sessions this app started: one hosted browser per profile at most.
//
// start(): plan the session from the profile (cloudbody.ts), create it, attach once so it starts
// (cdpattach.ts), then follow it. stop(): ask the service to stop it, and keep it as "stopping" until
// the service says it ended: a running browser is closed by its worker on its next report (~15 s), and
// until then it still costs money and still holds its saved profile. A poll reads each session's
// traffic and cost and notices when the service ended it (idle, a cap, the balance), and the list is
// kept in a file so a restarted app picks up the browsers still running on Clearcote's servers
// instead of forgetting them while they keep costing money.
//
// No Electron imports: everything outside (the API, the attach, the file) comes in through `deps`, so
// the whole lifecycle is tested with stubs (tests/cloud.test.ts).

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { cloudSessionPlan, type CloudInput } from "./cloudbody";
import { isFinalStatus, type CloudApi, type CloudResult, type SessionView } from "./cloudapi";
import type { AttachResult } from "./cdpattach";

export interface CloudSessionState {
  profileId: string;
  /** The profile's name when it started, for the tray and the viewer's title. */
  name: string;
  sid: string;
  /** ISO time the session was created. */
  startedAt: string;
  status: "starting" | "running" | "stopping";
  /** Where its traffic leaves, for display: "us · included IP" or the proxy without credentials. */
  exit?: string;
  bytes?: number;
  seconds?: number;
  costEur?: number;
}

export interface CloudEnded {
  profileId: string;
  name: string;
  sid: string;
  reason: string | null;
  status?: string;
  bytes?: number;
  costEur?: number;
}

export type CloudStartResult =
  | { ok: true; sid: string; warnings: string[] }
  | { ok: false; error: string; code?: string; status?: number; field?: string };

export interface CloudDeps {
  /** A client for the current settings, or why there is none (no key, a bad address). */
  api: () => CloudApi | { error: string; code: string };
  attach: (connectUrl: string) => Promise<AttachResult>;
  /** Where the list of running sessions is kept across restarts. */
  file: string;
  /** A profile running on this PC cannot also run in the cloud (and the reverse). */
  runningLocally?: (profileId: string) => boolean;
  pollMs?: number;
  /** How often to ask while a session is stopping (default 2 s): its end is due within seconds. */
  stopPollMs?: number;
  now?: () => number;
  /** Waits before trying again when the service has no free browser (503 NO_CAPACITY, which tells
   *  the caller to "retry in a few seconds"). Default: three retries over about 16 seconds. */
  capacityRetryMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

const NO_KEY = "Add your Clearcote API key in Settings → Cloud to run profiles in the cloud.";

export class CloudManager extends EventEmitter {
  private readonly sessions = new Map<string, CloudSessionState>();
  private timer: NodeJS.Timeout | null = null;
  private timerMs = 0;
  private polling = false;
  /** Sessions this app asked to stop: their end is the person's own, whatever reason the worker gives. */
  private readonly userStopped = new Set<string>();

  constructor(private readonly deps: CloudDeps) {
    super();
  }

  list(): CloudSessionState[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }

  has(profileId: string): boolean {
    return this.sessions.has(profileId);
  }

  get(profileId: string): CloudSessionState | undefined {
    const s = this.sessions.get(profileId);
    return s ? { ...s } : undefined;
  }

  private client(): CloudApi | { error: string; code: string } {
    const c = this.deps.api();
    return "error" in c ? { error: c.error || NO_KEY, code: c.code } : c;
  }

  private changed(): void {
    this.persist();
    this.emit("changed", this.list());
    const stopping = [...this.sessions.values()].some((s) => s.status === "stopping");
    const ms = !this.sessions.size ? 0 : stopping ? (this.deps.stopPollMs ?? 2_000) : (this.deps.pollMs ?? 15_000);
    if (ms === this.timerMs) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.timerMs = ms;
    if (ms) {
      this.timer = setInterval(() => void this.refresh(), ms);
      this.timer.unref?.();
    }
  }

  private persist(): void {
    const rows = this.list().map(({ profileId, name, sid, startedAt, exit }) => ({ profileId, name, sid, startedAt, exit }));
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), "utf8");
      fs.renameSync(tmp, this.deps.file);
    } catch {
      /* the list is a convenience; a failed write only means a restart will not find them */
    }
  }

  private ended(s: CloudSessionState, reason: string | null, view?: SessionView): void {
    if (this.userStopped.delete(s.sid)) reason = "stopped:user";
    this.sessions.delete(s.profileId);
    const usage = view?.usage;
    this.emit("ended", {
      profileId: s.profileId,
      name: s.name,
      sid: s.sid,
      reason,
      status: view?.status,
      bytes: usage ? usage.bytesUp + usage.bytesDown : s.bytes,
      costEur: view?.costEur ?? s.costEur,
    } satisfies CloudEnded);
  }

  private apply(s: CloudSessionState, v: SessionView): void {
    if (v.usage) {
      s.bytes = v.usage.bytesUp + v.usage.bytesDown;
      s.seconds = v.usage.seconds;
    }
    if (typeof v.costEur === "number") s.costEur = v.costEur;
  }

  async start(p: CloudInput & { name?: string }): Promise<CloudStartResult> {
    const existing = this.sessions.get(p.id);
    if (existing?.status === "stopping") {
      return { ok: false, error: "This profile is still stopping in the cloud. Start it again once it has stopped.", code: "STOPPING" };
    }
    if (existing) return { ok: false, error: "This profile is already running in the cloud.", code: "ALREADY_RUNNING" };
    if (this.deps.runningLocally?.(p.id)) {
      return { ok: false, error: "This profile's browser is open on this PC. Stop it first: a profile runs in one place at a time.", code: "RUNNING_LOCALLY" };
    }
    const plan = cloudSessionPlan(p);
    if (!plan.ok) return { ok: false, error: plan.error, code: "PROFILE", field: plan.field };
    const api = this.client();
    if ("error" in api) return { ok: false, error: api.error, code: api.code };

    let created = await api.create(plan.body);
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (const wait of this.deps.capacityRetryMs ?? [3000, 5000, 8000]) {
      if (created.ok || created.code !== "NO_CAPACITY") break;
      await sleep(wait);
      created = await api.create(plan.body);
    }
    if (!created.ok) return { ok: false, error: created.error, code: created.code, status: created.status };
    const exit = plan.exit.kind === "managed" ? `${plan.exit.country ? `${plan.exit.country.toUpperCase()} · ` : ""}included IP` : plan.exit.proxy;
    const s: CloudSessionState = {
      profileId: p.id,
      name: p.name?.trim() || p.id,
      sid: created.data.id,
      startedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
      status: "starting",
      exit,
    };
    this.sessions.set(p.id, s);
    this.changed();

    const att = await this.deps.attach(created.data.connectUrl);
    const live = this.sessions.get(p.id);
    if (!live || live.sid !== s.sid || live.status === "stopping") {
      // Stopped while it was starting: stop() follows it from here.
      return { ok: false, error: "It was stopped before it finished starting.", code: "STOPPED" };
    }
    if (!att.ok) {
      // A session that never started still holds a slot until it expires: end it now.
      await api.stop(s.sid).catch(() => undefined);
      if (this.sessions.get(p.id)?.sid === s.sid) this.sessions.delete(p.id);
      this.changed();
      return { ok: false, error: `The cloud browser did not start: ${att.error}`, code: "ATTACH", status: att.status };
    }
    live.status = "running";
    this.changed();
    return { ok: true, sid: s.sid, warnings: [...(created.data.warnings ?? [])] };
  }

  /**
   * Ask the service to stop a profile's session. Resolves once the service accepted it; the session
   * stays "stopping" until the service reports it ended (at once for one that never started, on the
   * worker's next report for a running one), and then "ended" fires with the final usage.
   */
  async stop(profileId: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.sessions.get(profileId);
    if (!s) return { ok: true };
    const api = this.client();
    if ("error" in api) return { ok: false, error: api.error };
    const was = s.status;
    s.status = "stopping";
    this.changed();
    const r: CloudResult<SessionView> = await api.stop(s.sid);
    const cur = this.sessions.get(profileId);
    if (!cur || cur.sid !== s.sid) return { ok: true }; // a poll already saw it end
    if (!r.ok && r.status !== 404) {
      cur.status = was;
      this.changed();
      return { ok: false, error: r.error };
    }
    this.userStopped.add(cur.sid);
    if (!r.ok) this.ended(cur, null);
    else {
      this.apply(cur, r.data);
      if (isFinalStatus(r.data.status)) this.ended(cur, null, r.data);
    }
    this.changed();
    return { ok: true };
  }

  /** Ask the service to stop every session (quitting with "close browsers"); resolves when each was answered. */
  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((s) => this.stop(s.profileId)));
  }

  /** Read every session's usage and notice the ones the service ended. */
  async refresh(): Promise<void> {
    if (this.polling || !this.sessions.size) return;
    const api = this.client();
    if ("error" in api) return;
    this.polling = true;
    try {
      let touched = false;
      for (const s of [...this.sessions.values()]) {
        if (s.status === "starting") continue;
        const r = await api.get(s.sid);
        if (!this.sessions.has(s.profileId)) continue; // stopped meanwhile
        if (r.ok) {
          this.apply(s, r.data);
          if (isFinalStatus(r.data.status)) this.ended(s, r.data.endReason ?? null, r.data);
          else if (r.data.stopRequested && s.status === "running") s.status = "stopping";
          touched = true;
        } else if (r.status === 404) {
          this.ended(s, null);
          touched = true;
        }
        // Network trouble or a 5xx: keep it, and ask again next time.
      }
      if (touched) this.changed();
    } finally {
      this.polling = false;
    }
  }

  /** After a restart: take back the sessions that are still running, drop the rest. */
  async restore(): Promise<void> {
    let rows: { profileId?: unknown; name?: unknown; sid?: unknown; startedAt?: unknown; exit?: unknown }[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.file, "utf8"));
      rows = Array.isArray(raw) ? raw : [];
    } catch {
      return;
    }
    const api = this.client();
    if ("error" in api) return;
    for (const row of rows) {
      if (!row || typeof row.profileId !== "string" || typeof row.sid !== "string" || this.sessions.has(row.profileId)) continue;
      const r = await api.get(row.sid);
      // Gone, ended, or not a session id: drop it. Unreachable or a server error: keep it, and let the
      // next poll decide, so a restart without a connection does not forget a browser still billing.
      if (r.ok ? isFinalStatus(r.data.status) : r.status === 404 || r.status === 410 || r.code === "BAD_ID") continue;
      const s: CloudSessionState = {
        profileId: row.profileId,
        name: typeof row.name === "string" ? row.name : row.profileId,
        sid: row.sid,
        startedAt: typeof row.startedAt === "string" ? row.startedAt : new Date().toISOString(),
        status: r.ok && r.data.stopRequested ? "stopping" : "running",
        exit: typeof row.exit === "string" ? row.exit : undefined,
      };
      if (r.ok) this.apply(s, r.data);
      this.sessions.set(s.profileId, s);
    }
    this.changed();
  }

  /** A fresh 60-second live-view URL for a profile's session (the viewer asks on every (re)connect). */
  async viewUrl(profileId: string, control = true): Promise<{ ok: true; viewUrl: string; interactive: boolean } | { ok: false; error: string; ended?: boolean }> {
    const s = this.sessions.get(profileId);
    if (!s) return { ok: false, error: "This profile is not running in the cloud.", ended: true };
    if (s.status === "stopping") return { ok: false, error: "Stopping…", ended: false };
    const api = this.client();
    if ("error" in api) return { ok: false, error: api.error };
    const r = await api.live(s.sid, control);
    if (!r.ok) return { ok: false, error: r.error, ended: r.status === 404 || r.status === 410 };
    return { ok: true, viewUrl: r.data.viewUrl, interactive: r.data.interactive === true };
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.removeAllListeners();
  }
}
