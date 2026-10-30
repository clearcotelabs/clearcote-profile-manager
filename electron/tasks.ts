// Saved tasks: a task that worked, kept to run again later on other profiles or with other values. A saved task
// is the recipe (goal with {{slots}}, start page, how to run it) plus what happened: the steps of its last
// successful run, to show as a timeline, and a short run history. Re-running it reuses the skill Jet saved on
// this PC (keyed on the goal template and start page), so a repeat needs no model.
// Stored as one JSON file next to the profiles. Nothing here touches Electron except the path.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { StepSummary } from "./jetsync";

/** One value a task asks for. "profile": each profile's own task value; "run": one value for every profile,
 *  typed when the task runs (the default below prefilled). */
export interface TaskParam {
  name: string;
  source: "profile" | "run";
  default?: string;
  secret?: boolean;
  /** Shown next to the field, e.g. "the search words". */
  hint?: string;
}

export interface TaskRunRecord {
  at: number;
  /** How many profiles ran and how many finished the task. */
  total: number;
  done: number;
  /** The run's own values that are not secret ({{slot}} → value), to run it again the same way. */
  params?: Record<string, string>;
  usd?: number;
}

export interface SavedTask {
  id: string;
  name: string;
  goal: string;
  url?: string;
  params: TaskParam[];
  confirm: boolean;
  concurrency?: number;
  staggerSec?: [number, number];
  closeWhenDone?: boolean;
  createdAt: number;
  updatedAt: number;
  /** Steps of the last run that finished, as Jet reported them; secret values are already their {{slot}}. */
  steps?: StepSummary[];
  /** The profile those steps come from (its name at the time). */
  stepsFrom?: string;
  /** Newest first, at most HISTORY_KEPT. */
  history: TaskRunRecord[];
}

export const HISTORY_KEPT = 20;
const STEPS_KEPT = 200;

export function tasksPath(root: string): string {
  return path.join(root, "tasks.json");
}

export function readTasks(file: string): SavedTask[] {
  try {
    return parseTasks(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function parseTasks(text: string): SavedTask[] {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new SyntaxError("tasks.json is not a list");
  return data.filter((t) => t && typeof t.id === "string" && typeof t.goal === "string").map(normalizeTask);
}

/** The list a write starts from. A missing file is an empty list; a file that cannot be read is an error
 *  (a write would replace every saved task), and one that cannot be parsed is kept aside as tasks.json.bad-<time>. */
function readForWrite(file: string): SavedTask[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return parseTasks(text);
  } catch {
    fs.renameSync(file, `${file}.bad-${Date.now()}`);
    return [];
  }
}

function writeTasks(file: string, list: SavedTask[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** A task from the renderer or the file, with every field in range. */
export function normalizeTask(t: Partial<SavedTask>): SavedTask {
  const now = Date.now();
  const params = Array.isArray(t.params)
    ? t.params
        .filter((p) => p && /^[A-Za-z_][\w.-]{0,63}$/.test(String(p.name)))
        .map((p) => ({
          name: String(p.name),
          source: p.source === "run" ? ("run" as const) : ("profile" as const),
          ...(p.default != null && !p.secret ? { default: String(p.default) } : {}),
          ...(p.secret ? { secret: true } : {}),
          ...(p.hint ? { hint: String(p.hint).slice(0, 200) } : {}),
        }))
    : [];
  return {
    id: typeof t.id === "string" && /^[\w-]{1,64}$/.test(t.id) ? t.id : crypto.randomUUID(),
    name: String(t.name ?? "").trim().slice(0, 120) || String(t.goal ?? "").slice(0, 60) || "Task",
    goal: String(t.goal ?? ""),
    ...(t.url ? { url: String(t.url) } : {}),
    params,
    confirm: t.confirm !== false,
    ...(t.concurrency ? { concurrency: Number(t.concurrency) } : {}),
    ...(Array.isArray(t.staggerSec) && t.staggerSec.length === 2 ? { staggerSec: [Number(t.staggerSec[0]), Number(t.staggerSec[1])] as [number, number] } : {}),
    ...(t.closeWhenDone ? { closeWhenDone: true } : {}),
    createdAt: Number(t.createdAt) || now,
    updatedAt: Number(t.updatedAt) || now,
    ...(Array.isArray(t.steps) ? { steps: t.steps.slice(0, STEPS_KEPT) } : {}),
    ...(t.stepsFrom ? { stepsFrom: String(t.stepsFrom) } : {}),
    history: Array.isArray(t.history) ? t.history.slice(0, HISTORY_KEPT).map((h) => withoutSecrets(h, params)) : [],
  };
}

/** A run record without values for slots that are secret now (a value may have been marked secret later). */
function withoutSecrets(h: TaskRunRecord, params: TaskParam[]): TaskRunRecord {
  if (!h?.params) return h;
  const secret = new Set(params.filter((p) => p.secret).map((p) => p.name));
  const kept = Object.fromEntries(Object.entries(h.params).filter(([k]) => !secret.has(k)));
  const { params: _p, ...rest } = h;
  return Object.keys(kept).length ? { ...rest, params: kept } : rest;
}

/** Save (insert or replace by id); secret params never keep a default. Returns the saved task. */
export function saveTask(file: string, t: Partial<SavedTask>): SavedTask {
  const list = readForWrite(file);
  const i = typeof t.id === "string" ? list.findIndex((x) => x.id === t.id) : -1;
  if (i >= 0) {
    // An update changes the recipe only. What happened (history, the steps of the last run) belongs to the
    // runs, which recordRun writes; a renderer's copy may be stale or partial and must not replace it.
    const prev = list[i];
    const { history: _h, steps: _s, stepsFrom: _f, createdAt: _c, ...recipe } = t;
    list[i] = { ...normalizeTask({ ...prev, ...recipe, history: prev.history, steps: prev.steps, stepsFrom: prev.stepsFrom }), createdAt: prev.createdAt, updatedAt: Date.now() };
    writeTasks(file, list);
    return list[i];
  }
  const task = { ...normalizeTask(t), updatedAt: Date.now() };
  list.unshift(task);
  writeTasks(file, list);
  return task;
}

export function deleteTask(file: string, id: string): boolean {
  const list = readForWrite(file);
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  writeTasks(file, next);
  return true;
}

/** Add a finished run to a task's history; with steps from a profile that finished, they become the timeline.
 *  `onlyIfNone`: steps that were only replayed fill an empty timeline but never replace learned ones. */
/** Steps as a saved task keeps them: typed text as its {{slots}}, not one profile's values. */
export function forTask(steps: StepSummary[]): StepSummary[] {
  return steps.map(({ template, ...s }) => (template !== undefined ? { ...s, text: template } : s));
}

export function recordRun(file: string, id: string, rec: TaskRunRecord, steps?: { steps: StepSummary[]; from: string; onlyIfNone?: boolean }): SavedTask | null {
  const list = readForWrite(file);
  const t = list.find((x) => x.id === id);
  if (!t) return null;
  t.history = [rec, ...t.history].slice(0, HISTORY_KEPT);
  if (steps?.steps.length && !(steps.onlyIfNone && t.steps?.length)) {
    t.steps = forTask(steps.steps).slice(0, STEPS_KEPT);
    t.stepsFrom = steps.from;
  }
  t.updatedAt = Date.now();
  writeTasks(file, list);
  return t;
}
