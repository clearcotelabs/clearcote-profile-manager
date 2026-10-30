// electron/tasks.ts — the saved-tasks file: read, save, delete, and run history. Real files in a temp dir.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTasks, saveTask, deleteTask, recordRun, forTask, tasksPath, HISTORY_KEPT, type SavedTask } from "../electron/tasks";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-tasks-test-"));
  file = tasksPath(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const noTmpLeft = () => expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);

describe("readTasks", () => {
  it("a missing or corrupt file is an empty list", () => {
    expect(readTasks(file)).toEqual([]);
    fs.writeFileSync(file, "{not json");
    expect(readTasks(file)).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ id: "x", goal: "y" }));
    expect(readTasks(file)).toEqual([]);
  });

  it("drops entries without an id or goal", () => {
    fs.writeFileSync(file, JSON.stringify([{ id: "a", goal: "g" }, { id: 1, goal: "g" }, null, { id: "b" }]));
    expect(readTasks(file).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("saveTask", () => {
  it("inserts newest first and writes atomically", () => {
    saveTask(file, { id: "one", goal: "first" });
    saveTask(file, { id: "two", goal: "second" });
    expect(readTasks(file).map((t) => t.id)).toEqual(["two", "one"]);
    noTmpLeft();
  });

  it("replaces by id, keeping createdAt and position", async () => {
    const a = saveTask(file, { id: "one", goal: "first", createdAt: 1000 });
    saveTask(file, { id: "two", goal: "second" });
    expect(a.createdAt).toBe(1000);
    const b = saveTask(file, { id: "one", goal: "first, edited", createdAt: 999999 });
    expect(b.createdAt).toBe(1000);
    expect(b.goal).toBe("first, edited");
    const list = readTasks(file);
    expect(list.map((t) => t.id)).toEqual(["two", "one"]);
    expect(list[1]).toMatchObject({ goal: "first, edited", createdAt: 1000 });
    noTmpLeft();
  });

  it("generates an id when missing or invalid", () => {
    const a = saveTask(file, { goal: "g" });
    const b = saveTask(file, { id: "bad id/../x", goal: "g" });
    expect(a.id).toMatch(/^[\w-]{1,64}$/);
    expect(b.id).toMatch(/^[\w-]{1,64}$/);
    expect(b.id).not.toBe("bad id/../x");
    expect(a.id).not.toBe(b.id);
    expect(readTasks(file)).toHaveLength(2);
  });

  it("a secret param never keeps a default; bad param names are dropped", () => {
    const t = saveTask(file, {
      id: "p",
      goal: "log in as {{email}} with {{pw}}",
      params: [
        { name: "email", source: "run", default: "a@x.io" },
        { name: "pw", source: "run", default: "hunter2", secret: true },
        { name: "1bad", source: "run" },
        { name: "has space", source: "profile" },
        { name: "", source: "profile" },
      ],
    });
    expect(t.params).toEqual([
      { name: "email", source: "run", default: "a@x.io" },
      { name: "pw", source: "run", secret: true },
    ]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("hunter2");
  });

  it("clamps the name, falling back to the goal", () => {
    expect(saveTask(file, { goal: "g", name: "x".repeat(500) }).name).toHaveLength(120);
    expect(saveTask(file, { goal: "y".repeat(100), name: "   " }).name).toBe("y".repeat(60));
    expect(saveTask(file, { goal: "", name: "" }).name).toBe("Task");
  });
});

describe("deleteTask", () => {
  it("true when removed, false when not there", () => {
    saveTask(file, { id: "one", goal: "g" });
    saveTask(file, { id: "two", goal: "g" });
    expect(deleteTask(file, "nope")).toBe(false);
    expect(deleteTask(file, "one")).toBe(true);
    expect(readTasks(file).map((t) => t.id)).toEqual(["two"]);
    expect(deleteTask(file, "one")).toBe(false);
    noTmpLeft();
  });
});

describe("recordRun", () => {
  const step = (action: string) => ({ kind: "click", action });

  it("returns null for an unknown task", () => {
    expect(recordRun(file, "nope", { at: 1, total: 1, done: 1 })).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("prepends history, capped at HISTORY_KEPT", () => {
    saveTask(file, { id: "t", goal: "g" });
    for (let i = 0; i < HISTORY_KEPT + 5; i++) recordRun(file, "t", { at: i, total: 2, done: 1 });
    const t = readTasks(file)[0] as SavedTask;
    expect(t.history).toHaveLength(HISTORY_KEPT);
    expect(t.history[0].at).toBe(HISTORY_KEPT + 4);
    expect(t.history[HISTORY_KEPT - 1].at).toBe(5);
    noTmpLeft();
  });

  it("replaces steps only when steps are given and non-empty", () => {
    saveTask(file, { id: "t", goal: "g" });
    let t = recordRun(file, "t", { at: 1, total: 1, done: 1 }, { steps: [step("a")], from: "Profile A" })!;
    expect(t.steps).toEqual([step("a")]);
    expect(t.stepsFrom).toBe("Profile A");
    t = recordRun(file, "t", { at: 2, total: 1, done: 0 }, { steps: [], from: "Profile B" })!;
    expect(t.steps).toEqual([step("a")]);
    expect(t.stepsFrom).toBe("Profile A");
    t = recordRun(file, "t", { at: 3, total: 1, done: 0 })!;
    expect(t.steps).toEqual([step("a")]);
    t = recordRun(file, "t", { at: 4, total: 1, done: 1, params: { q: "shoes" } }, { steps: [step("b"), step("c")], from: "Profile C" })!;
    expect(readTasks(file)[0]).toMatchObject({ steps: [step("b"), step("c")], stepsFrom: "Profile C" });
    expect(readTasks(file)[0].history.map((h) => h.at)).toEqual([4, 3, 2, 1]);
    expect(readTasks(file)[0].history[0].params).toEqual({ q: "shoes" });
  });
});

describe("forTask", () => {
  it("keeps a step's {{slot}} template instead of one profile's value", () => {
    expect(
      forTask([
        { kind: "fill", action: "Email", text: "ana@example.com", template: "{{email}}" },
        { kind: "fill", action: "Search", text: "shoes" },
      ]),
    ).toEqual([
      { kind: "fill", action: "Email", text: "{{email}}" },
      { kind: "fill", action: "Search", text: "shoes" },
    ]);
  });

  it("recordRun stores the templated steps", () => {
    saveTask(file, { id: "t", goal: "g" });
    recordRun(file, "t", { at: 1, total: 1, done: 1 }, { steps: [{ kind: "fill", action: "Email", text: "ana@example.com", template: "{{email}}" }], from: "A" });
    expect(readTasks(file)[0].steps).toEqual([{ kind: "fill", action: "Email", text: "{{email}}" }]);
  });
});

describe("saveTask on an existing task", () => {
  it("changes the recipe but keeps the history and steps recordRun wrote", () => {
    saveTask(file, { id: "t", name: "Old", goal: "log in as {{email}}", params: [{ name: "email", source: "profile" }] });
    recordRun(file, "t", { at: 1, total: 2, done: 2 }, { steps: [{ kind: "click", action: "Sign in" }], from: "A" });
    // What Run a task sends with "Update the saved task": the recipe, no history.
    const saved = saveTask(file, { id: "t", name: "New", goal: "log in as {{email}}", url: undefined, params: [{ name: "email", source: "run", default: "x@y.z" }] });
    expect(saved.name).toBe("New");
    expect(saved.params).toEqual([{ name: "email", source: "run", default: "x@y.z" }]);
    expect(saved.history).toEqual([{ at: 1, total: 2, done: 2 }]);
    expect(saved.steps).toEqual([{ kind: "click", action: "Sign in" }]);
    expect(saved.stepsFrom).toBe("A");
    expect(readTasks(file)[0]).toEqual(saved);
  });

  it("ignores a stale history or steps sent with an update", () => {
    saveTask(file, { id: "t", goal: "g" });
    recordRun(file, "t", { at: 2, total: 1, done: 1 }, { steps: [{ kind: "click", action: "Go" }], from: "B" });
    const saved = saveTask(file, { id: "t", goal: "g2", history: [], steps: [] });
    expect(saved.goal).toBe("g2");
    expect(saved.history).toHaveLength(1);
    expect(saved.steps).toHaveLength(1);
  });

  it("a task saved again after it was deleted (undo) keeps what it carries", () => {
    const t = saveTask(file, { id: "t", goal: "g" });
    recordRun(file, "t", { at: 3, total: 1, done: 1 });
    const before = readTasks(file)[0];
    deleteTask(file, "t");
    const back = saveTask(file, before);
    expect(back.id).toBe(t.id);
    expect(back.history).toEqual(before.history);
  });
});
