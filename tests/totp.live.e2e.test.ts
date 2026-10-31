// End-to-end for {{otp}}: a profile with a 2FA secret signs in to a local page whose server checks the code against its
// own clock (RFC 6238, Node's crypto). The run goes through the real task runner, a real Jet worker and a real browser.
// What it proves: the code typed is valid when it arrives, and it is worked out when typed, not when the run started
// (the steps wait 31 s before typing, past the window the run started in); the secret never reaches the run board.
//   1. steps written by hand (no model): the replay works the code out at the step that types it;
//   2. with a model key: the model works the task out and types {{otp}}, and the loop types the code of that moment.
//
//   CLEARCOTE_TOTP_E2E=1 CLEARCOTE_BINARY=<chrome.exe> CLEARCOTE_JET_COMMAND="python -m clearcote_jet.cli" \
//   [CLEARCOTE_JET_ENV_FILE=<.env with TYPESAFE_API_KEY>] npx vitest run tests/totp.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Profile } from "../electron/types";
import type { SyncRun } from "../electron/jetsync";

const READY = process.env.CLEARCOTE_TOTP_E2E === "1" && !!process.env.CLEARCOTE_BINARY && !!process.env.CLEARCOTE_JET_COMMAND;
const MODEL = !!process.env.CLEARCOTE_JET_ENV_FILE;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-totp-live-")) : path.join(os.tmpdir(), "ccpm-totp-live-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const KEY = "KRSXG5CTMVRXEZLUKN2XAZLSKNSWG4TFOQ"; // base32 of "TestSecretSuperSecret"
const key = (() => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of KEY) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
})();
const windowOf = (ms: number) => Math.floor(ms / 1000 / 30);
function codeAt(counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", key).update(msg).digest();
  const o = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A sign-in page: user name, then a 2FA code checked on arrival (the current or the next window, as sites accept). */
function site() {
  const logins: { user: string; code: string; at: number; ok: boolean }[] = [];
  const page = (b: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in</title></head><body>${b}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/verify") {
      const at = Date.now();
      const code = u.searchParams.get("code") || "";
      const w = windowOf(at);
      const ok = code === codeAt(w) || code === codeAt(w + 1);
      logins.push({ user: u.searchParams.get("user") || "", code, at, ok });
      res.end(page(ok ? `<h1>Signed in</h1><p>Welcome back</p>` : `<h1>Wrong code</h1>`));
      return;
    }
    res.end(
      page(`<h1>Sign in</h1><form action="/verify" method="get">
        <label>User <input id="user" name="user"></label>
        <label>Authentication code <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
        <button type="submit">Verify</button></form>`),
    );
  });
  return { server, logins };
}

describe.skipIf(!READY)("e2e — {{otp}} types a code that is valid when it arrives", () => {
  const s = site();
  let base = "";
  let runs: SyncRun[] = [];
  let launcher: typeof import("../electron/launcher");

  beforeAll(async () => {
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/`;
    process.env.CLEARCOTE_JET_ALLOW_PRIVATE_EGRESS = "1";
    process.env.CLEARCOTE_JET_SKILLS = path.join(ROOT, "skills");
    const store = await import("../electron/store");
    let jetApiKey: string | undefined;
    if (MODEL) jetApiKey = fs.readFileSync(process.env.CLEARCOTE_JET_ENV_FILE!, "utf8").match(/^\s*TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m)?.[1]?.trim();
    store.writeSettings({ binaryPath: process.env.CLEARCOTE_BINARY, crlset: false, jetCommand: process.env.CLEARCOTE_JET_COMMAND, jetApiKey });
    launcher = await import("../electron/launcher");
    const profiles = await import("../electron/profiles");
    const now = new Date().toISOString();
    profiles.saveProfile({ id: "otp-a", name: "ana", fingerprint: "seed-otp-a", createdAt: now, updatedAt: now, totp: KEY } as Profile);
  }, 30000);

  afterAll(async () => {
    await launcher?.stopAll({ timeoutMs: 8000 });
    s.server.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }, 30000);

  async function runTask(goal: string, url: string) {
    const { getSyncManager } = await import("../electron/handlers");
    const mgr = getSyncManager({ cloud: () => ({ has: () => false }) as never });
    mgr.on("changed", (r: SyncRun[]) => (runs = r));
    const startedAt = Date.now();
    const started = mgr.start({ profileIds: ["otp-a"], goal, url, confirm: false, concurrency: 1, staggerSec: [0, 0], closeWhenDone: true });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const runId = (started as { runId: string }).runId;
    const row = () => runs.find((r) => r.id === runId)?.rows[0];
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline && !["done", "failed", "blocked", "needs_input", "stopped", "cancelled", "budget"].includes(String(row()?.status))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return { row: row()!, startedAt };
  }

  it("steps written by hand: waits 31 s, then types the code of that moment, and the server accepts it", async () => {
    const store = await import("../electron/store");
    const { saveTaskSkill } = await import("../electron/taskskill");
    const goal = "Sign in as {{name}} with the code {{otp}}";
    const saved = await saveTaskSkill(store.readSettings(), { goal, url: base }, [
      { kind: "fill", selector: "#user", text: "{{name}}" },
      { kind: "wait", seconds: 31 },
      { kind: "fill", selector: "#code", text: "{{otp}}" },
      { kind: "key", key: "Enter" },
      { kind: "wait_for", condition: { type: "text", value: "Signed in" }, seconds: 10 },
    ]);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const { row, startedAt } = await runTask(goal, base);
    expect(row.status, `${row.status}: ${row.detail ?? ""}`).toBe("done");
    const login = s.logins.at(-1)!;
    expect(login).toMatchObject({ user: "ana", ok: true });
    // Worked out when it was typed: not the code of the window the run started in.
    expect(login.code).not.toBe(codeAt(windowOf(startedAt)));
    expect(JSON.stringify(row)).not.toContain(KEY);
    expect(JSON.stringify(row)).not.toContain(login.code);
  }, 300000);

  it.skipIf(!MODEL)("with the model: it works the task out, types {{otp}}, and the code is the one of that moment", async () => {
    const goal = "Type {{name}} into User. Then wait 31 seconds (do nothing else while waiting), then type {{otp}} into Authentication code and press Verify.";
    const url = base + "?model=1";
    const before = s.logins.length;
    // The first run closed its browser when it finished: start once it is gone, not while it is closing.
    for (let i = 0; i < 60 && launcher.listRunning().includes("otp-a"); i++) await new Promise((r) => setTimeout(r, 250));
    const { row, startedAt } = await runTask(goal, url);
    expect(row.status, `${row.status}: ${row.detail ?? ""}`).toBe("done");
    const login = s.logins.slice(before).at(-1)!;
    expect(login).toMatchObject({ user: "ana", ok: true });
    expect(JSON.stringify(row)).not.toContain(KEY);
    // The model may not wait the full 31 s; when it did, the code is not the start window's.
    if (windowOf(login.at) > windowOf(startedAt)) expect(login.code).not.toBe(codeAt(windowOf(startedAt)));
  }, 300000);
});
