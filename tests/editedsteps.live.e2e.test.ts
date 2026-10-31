// End-to-end for steps edited by hand: they are saved through the app's own code (electron/taskskill.ts →
// clearcote-jet skill put), and a run of the task through the real task runner, a real Jet worker and a real
// browser does exactly them, with no model: an if block (a cookie banner that shows), a repeat-while loop (Load
// more until it is gone), wait-until, the page's own JavaScript, typing by CSS selector and a key press. What it
// proves is asked of the PAGE, which records every click it got.
//
// Opt-in: it needs a Chromium binary and a Jet with `skill` (0.5.0+). No model key: nothing is learned.
//
//   CLEARCOTE_STEPS_E2E=1 \
//   CLEARCOTE_BINARY="/path/to/chrome.exe" \
//   CLEARCOTE_JET_COMMAND="python -m clearcote_jet.cli"   # PYTHONPATH may point at a clearcote-jet checkout
//   npx vitest run tests/editedsteps.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { Profile } from "../electron/types";
import type { SyncRun } from "../electron/jetsync";
import type { EditStep } from "../electron/taskskill";

const READY = process.env.CLEARCOTE_STEPS_E2E === "1" && !!process.env.CLEARCOTE_BINARY && !!process.env.CLEARCOTE_JET_COMMAND;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-steps-")) : path.join(os.tmpdir(), "ccpm-steps-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

/** A shop page: a cookie banner, Load more (3 times, then it is gone), and a search box. Records every hit. */
function shop() {
  const hits: string[] = [];
  const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shop</title></head><body>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname === "/hit") {
      hits.push(u.searchParams.get("what") || "");
      res.writeHead(204).end();
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/search") {
      hits.push(`search:${u.searchParams.get("q")}`);
      res.end(page(`<h1>Results for ${String(u.searchParams.get("q")).replace(/[<>&"]/g, "")}</h1>`));
      return;
    }
    res.end(
      page(`<div id="banner"><p>We use cookies</p><button onclick="fetch('/hit?what=accept');document.getElementById('banner').remove()">Accept cookies</button></div>
        <h1>Shop</h1><ul id="list"></ul>
        <button id="more" onclick="more()">Load more</button>
        <form action="/search" method="get"><input id="q" name="q" aria-label="Search the shop"></form>
        <script>
          let n = 0, rounds = 0;
          function more() {
            fetch('/hit?what=more');
            for (let i = 0; i < 5; i++) { const li = document.createElement('li'); li.textContent = 'Item ' + (++n); document.getElementById('list').append(li); }
            if (++rounds === 3) document.getElementById('more').remove();
          }
        </script>`),
    );
  });
  return { server, hits };
}

const STEPS: EditStep[] = [
  { kind: "if", condition: { type: "text", value: "We use cookies" }, then: [{ kind: "click", role: "button", label: "Accept cookies" }], else: [] },
  { kind: "while", condition: { type: "control", value: "Load more" }, then: [{ kind: "click", role: "button", label: "Load more" }], max: 10 },
  { kind: "wait_for", condition: { type: "text", value: "Item 15" }, seconds: 10 },
  { kind: "js", code: "await fetch('/hit?what=js-' + document.querySelectorAll('li').length);" },
  { kind: "if", condition: { type: "selector", value: "#nothing-here" }, then: [{ kind: "goto", url: "https://example.invalid/" }], else: [{ kind: "wait", seconds: 0.2 }] },
  { kind: "fill", selector: "#q", text: "{{query}}" },
  { kind: "key", key: "Enter" },
  { kind: "wait_for", condition: { type: "url", value: "/search" }, seconds: 10 },
];

describe.skipIf(!READY)("e2e — a task's steps edited by hand run exactly as written", () => {
  const s = shop();
  let base = "";
  let runs: SyncRun[] = [];
  let launcher: typeof import("../electron/launcher");

  beforeAll(async () => {
    await new Promise<void>((r) => s.server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(s.server.address() as AddressInfo).port}/`;
    process.env.CLEARCOTE_JET_ALLOW_PRIVATE_EGRESS = "1";
    process.env.CLEARCOTE_JET_SKILLS = path.join(ROOT, "skills");
    const store = await import("../electron/store");
    store.writeSettings({ binaryPath: process.env.CLEARCOTE_BINARY, crlset: false, jetCommand: process.env.CLEARCOTE_JET_COMMAND });
    launcher = await import("../electron/launcher");
  }, 30000);

  afterAll(async () => {
    await launcher?.stopAll({ timeoutMs: 8000 });
    s.server.close();
    fs.rmSync(ROOT, { recursive: true, force: true });
  }, 30000);

  it("saves the steps, and a run does them — if, repeat, wait until, JavaScript, selector, key — with no model", async () => {
    const store = await import("../electron/store");
    const { getTaskSkill, saveTaskSkill, resetTaskSkill } = await import("../electron/taskskill");
    const tasks = await import("../electron/tasks");
    const task = tasks.saveTask(tasks.tasksPath(store.ROOT), { name: "Shop search", goal: "Search the shop for {{query}}", url: base, params: [], confirm: false });

    expect(await getTaskSkill(store.readSettings(), task)).toEqual({ ok: true, skill: null });
    const saved = await saveTaskSkill(store.readSettings(), task, STEPS);
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    const back = await getTaskSkill(store.readSettings(), task);
    expect(back).toMatchObject({ ok: true, skill: { edited: true, steps: STEPS } });
    // Jet checks the steps too: one that cannot run is refused with which one.
    expect(await saveTaskSkill(store.readSettings(), task, [{ kind: "goto", url: "file:///etc/passwd" }])).toMatchObject({ ok: false, error: expect.stringMatching(/step 1/) });

    const profiles = await import("../electron/profiles");
    const now = new Date().toISOString();
    profiles.saveProfile({ id: "steps-a", name: "steps-a", fingerprint: "seed-steps-a", createdAt: now, updatedAt: now, vars: [{ key: "query", value: "teapot" }] } as Profile);
    const { getSyncManager } = await import("../electron/handlers");
    const mgr = getSyncManager({ cloud: () => ({ has: () => false }) as never });
    mgr.on("changed", (r: SyncRun[]) => (runs = r));
    const started = mgr.start({ profileIds: ["steps-a"], goal: task.goal, url: base, confirm: false, concurrency: 1, staggerSec: [0, 0], closeWhenDone: true, taskId: task.id });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    const runId = (started as { runId: string }).runId;
    const row = () => runs.find((r) => r.id === runId)?.rows[0];
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline && !["done", "failed", "blocked", "needs_input", "stopped", "cancelled", "budget"].includes(String(row()?.status))) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const r = row()!;
    expect(r.status, `${r.status}: ${r.detail ?? ""}`).toBe("done");
    expect(s.hits).toEqual(["accept", "more", "more", "more", "js-15", "search:teapot"]);
    expect(r.usd ?? 0).toBe(0);
    expect(r.steps.every((x) => x.replayed !== false)).toBe(true);

    expect(await resetTaskSkill(store.readSettings(), task)).toEqual({ ok: true, forgot: true });
    expect(await getTaskSkill(store.readSettings(), task)).toEqual({ ok: true, skill: null });
  }, 240000);
});
