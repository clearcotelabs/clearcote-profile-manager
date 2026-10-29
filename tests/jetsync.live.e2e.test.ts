// End-to-end for "Run a task": the app's real launcher opens real browsers with automation, the real task
// runner starts real Jet workers (clearcote-jet worker) that attach to them, and a real task runs on a local
// shop page in each profile. What it proves, by asking the PAGE what happened:
//   - each profile typed ITS OWN value ({{email}}) and the secret one ({{password}}) reached the page
//   - the first profile learned the task and the second replayed it with no model calls
//   - with approval on, both stopped before "Place order", and nothing was ordered until approved
//   - no secret value reached the run board
//
// Opt-in: it needs a Chromium binary, Jet, and Jet's model key (learning the task costs about $0.001):
//
//   CLEARCOTE_SYNC_E2E=1 \
//   CLEARCOTE_BINARY="/path/to/chrome.exe"              # a Clearcote build, or any Chromium
//   CLEARCOTE_JET_COMMAND="python -m clearcote_jet.cli"  # with clearcote-jet importable
//   CLEARCOTE_JET_ENV_FILE="/path/to/.env"              # holds TYPESAFE_API_KEY=... (read here, never copied)
//   npx vitest run tests/jetsync.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Profile } from "../electron/types";
import type { SyncRun } from "../electron/jetsync";

const READY =
  process.env.CLEARCOTE_SYNC_E2E === "1" && !!process.env.CLEARCOTE_BINARY && !!process.env.CLEARCOTE_JET_COMMAND && !!process.env.CLEARCOTE_JET_ENV_FILE;

const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-sync-")) : path.join(os.tmpdir(), "ccpm-sync-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

function jetKey(): string {
  const text = fs.readFileSync(process.env.CLEARCOTE_JET_ENV_FILE!, "utf8");
  const m = text.match(/^\s*TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n]+)/m);
  if (!m) throw new Error("no TYPESAFE_API_KEY in CLEARCOTE_JET_ENV_FILE");
  return m[1].trim();
}

/** A two-page shop: sign in, then an order page whose button can't be taken back. Records what arrived. */
function shop() {
  const orders: { email: string; password: string }[] = [];
  const signins: { email: string; password: string }[] = [];
  const page = (body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Test shop</title></head><body>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/") {
      res.end(
        page(`<h1>Test shop</h1><form action="/order" method="get">
          <label>Email <input name="email" type="email" required></label>
          <label>Password <input name="password" type="password" required></label>
          <button type="submit">Sign in</button></form>`),
      );
    } else if (u.pathname === "/order") {
      const email = u.searchParams.get("email") || "";
      const password = u.searchParams.get("password") || "";
      signins.push({ email, password });
      res.end(
        page(`<h1>Your basket</h1><p>Signed in as ${email.replace(/[<>&"]/g, "")}</p><p>1 × Blue mug, £8.00</p>
          <form action="/done" method="get"><input type="hidden" name="email" value="${email.replace(/[<>&"]/g, "")}">
          <input type="hidden" name="password" value="${password.replace(/[<>&"]/g, "")}">
          <button type="submit">Place order</button></form>`),
      );
    } else if (u.pathname === "/done") {
      orders.push({ email: u.searchParams.get("email") || "", password: u.searchParams.get("password") || "" });
      res.end(page(`<h1>Order placed</h1><p>Thank you. Your order number is 1042.</p>`));
    } else {
      res.statusCode = 404;
      res.end(page("Not found"));
    }
  });
  return { server, orders, signins };
}

describe.skipIf(!READY)("e2e — one task on two profiles, through real Jet workers", () => {
  const s = shop();
  let base = "";
  let runs: SyncRun[] = [];
  let launcher: typeof import("../electron/launcher");

  beforeAll(async () => {
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/`;
    // Jet refuses local addresses unless told: this page is local on purpose.
    process.env.CLEARCOTE_JET_ALLOW_PRIVATE_EGRESS = "1";
    process.env.CLEARCOTE_JET_SKILLS = path.join(ROOT, "skills");
    const store = await import("../electron/store");
    store.writeSettings({
      binaryPath: process.env.CLEARCOTE_BINARY,
      crlset: false,
      jetCommand: process.env.CLEARCOTE_JET_COMMAND,
      jetApiKey: jetKey(),
    });
    launcher = await import("../electron/launcher");
  }, 30000);

  afterAll(async () => {
    await launcher?.stopAll({ timeoutMs: 8000 });
    s.server.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }, 30000);

  it(
    "learns on the first, replays on the second, waits for approval, then orders with each profile's own values",
    async () => {
      const profiles = await import("../electron/profiles");
      const { getSyncManager } = await import("../electron/handlers");
      const now = new Date().toISOString();
      const mk = (id: string, email: string, password: string) =>
        profiles.saveProfile({
          id,
          name: id,
          fingerprint: `seed-${id}`,
          createdAt: now,
          updatedAt: now,
          vars: [{ key: "email", value: email }, { key: "password", value: password, secret: true }],
        } as Profile);
      mk("live-a", "ana@example.com", "pw-Ana-81!");
      mk("live-b", "tom@example.com", "pw-Tom-27!");

      const mgr = getSyncManager({ cloud: () => ({ has: () => false }) as never });
      mgr.on("changed", (r: SyncRun[]) => (runs = r));
      const started = mgr.start({
        profileIds: ["live-a", "live-b"],
        goal: "Sign in with the email {{email}} and the password {{password}}, then place the order.",
        url: base,
        confirm: true,
        concurrency: 1, // the second must start after the first has learned the task
        staggerSec: [0, 0],
        closeWhenDone: true,
      });
      expect(started.ok, JSON.stringify(started)).toBe(true);
      const runId = (started as { runId: string }).runId;
      const row = (id: string) => runs.find((r) => r.id === runId)?.rows.find((x) => x.profileId === id);

      const until = async (what: string, ok: () => boolean, ms = 240000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          if (ok()) return;
          const bad = runs.find((r) => r.id === runId)?.rows.find((x) => ["failed", "blocked", "budget", "needs_input"].includes(x.status));
          if (bad) throw new Error(`${what}: ${bad.profileId} ended ${bad.status}: ${bad.detail}`);
          await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`${what}: timed out; rows ${JSON.stringify(runs.find((r) => r.id === runId)?.rows)}`);
      };

      // The first profile: worked out with the model, stops before the irreversible click.
      await until("profile A waits for approval", () => row("live-a")?.status === "waiting_approval");
      expect(row("live-a")!.pending?.label).toMatch(/Place order/);
      expect(s.orders).toEqual([]);
      expect(s.signins).toEqual([{ email: "ana@example.com", password: "pw-Ana-81!" }]);
      mgr.approve(runId, "live-a");
      await until("profile A done", () => row("live-a")?.status === "done");
      expect(s.orders).toEqual([{ email: "ana@example.com", password: "pw-Ana-81!" }]);
      expect(row("live-a")!.skill).toBe("learned");

      // The second: replayed with no model, its own values, and it waits too.
      await until("profile B waits for approval", () => row("live-b")?.status === "waiting_approval");
      expect(s.signins[1]).toEqual({ email: "tom@example.com", password: "pw-Tom-27!" });
      expect(s.orders).toHaveLength(1);
      mgr.approve(runId, "live-b");
      await until("profile B done", () => row("live-b")?.status === "done");
      expect(s.orders[1]).toEqual({ email: "tom@example.com", password: "pw-Tom-27!" });
      expect(row("live-b")!.skill).toMatch(/replayed|shortcut/);
      expect(row("live-b")!.usd ?? 0).toBe(0);

      // Nothing the board holds carries a password, and the learned skill keeps only the slot.
      const board = JSON.stringify(runs);
      expect(board).not.toContain("pw-Ana-81!");
      expect(board).not.toContain("pw-Tom-27!");
      const skills = fs.readdirSync(path.join(ROOT, "skills")).map((f) => fs.readFileSync(path.join(ROOT, "skills", f), "utf8"));
      expect(skills.length).toBe(1);
      expect(skills[0]).not.toContain("pw-Ana-81!");
      expect(skills[0]).toContain("{{password}}");

      // "Close the browsers this task opened": both are closed again.
      await until("browsers closed", () => launcher.listRunning().length === 0, 30000);
    },
    600000,
  );
});
