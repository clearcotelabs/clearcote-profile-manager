// A saved task's steps as Jet replays them (its skill), read and saved by hand. Jet keeps a skill per goal and
// start page; `clearcote-jet skill get|put|forget` reads, saves (marked as edited) or forgets it, keyed exactly as
// a run keys it, so what is saved here is what the next run of the task does. Edited steps replay as written: a
// run that cannot get through them stops there and says where, and is not learned over.
//
// Steps are Jet's own shape (clearcote_jet/skills.py): recorded ones find a control by role and label; steps
// written here may also go to an address, wait, wait until something is true, press a key, run the page's own
// JavaScript, click or type by CSS selector, and hold if/else and repeat-while blocks. Nothing here touches Electron.

import { spawn } from "node:child_process";
import { normalizeTemplate } from "./jetslots";
import { parseCommandLine } from "./jetsync";
import type { Settings } from "./types";

export type ConditionType = "text" | "control" | "url" | "selector" | "js";
export interface StepCondition {
  type: ConditionType;
  value: string;
  /** True: the step goes on when the condition is NOT true. */
  not?: boolean;
}

export type EditKind =
  | "click"
  | "fill"
  | "select"
  | "scroll"
  | "find"
  | "wait"
  | "goto"
  | "key"
  | "js"
  | "wait_for"
  | "if"
  | "while";

/** One step. Recorded steps carry more (role, nth, value…) and keep it: the editor changes only what it shows. */
export interface EditStep {
  kind: EditKind;
  label?: string;
  role?: string | null;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  seconds?: number;
  key?: string;
  code?: string;
  delta?: number;
  condition?: StepCondition;
  then?: EditStep[];
  else?: EditStep[];
  max?: number;
  [more: string]: unknown;
}

export interface TaskSkill {
  steps: EditStep[];
  /** Saved by hand (else learned by Jet). */
  edited: boolean;
  editedAt?: string;
  learnedAt?: string;
}

export type SkillResult<T> = { ok: true } & T | { ok: false; error: string; code?: "NO_URL" | "JET_OLD" | "NO_JET" };

export const KEYS = ["Enter", "Tab", "Escape", "Space", "Backspace", "Delete", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End"];

const JET_OLD = 'This Jet cannot edit steps yet (it needs 0.5.0 or newer). Update it under Settings → Tasks (Install Jet), or with "pip install -U git+https://github.com/clearcotelabs/clearcote-jet".';

/** Steps that run JavaScript, at any depth (the web version may not save those). */
export function usesJavaScript(steps: EditStep[]): boolean {
  return steps.some(
    (s) => s.kind === "js" || s.condition?.type === "js" || usesJavaScript(s.then ?? []) || usesJavaScript(s.else ?? []),
  );
}

/** Spawns `<jet> skill <action>`; resolves with its parsed JSON line. Injected in tests. */
export type RunSkill = (cmd: string, args: string[], stdin: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runProcess: RunSkill = (cmd, args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

async function skill(
  s: Pick<Settings, "jetCommand">,
  action: "get" | "put" | "forget",
  task: { goal: string; url?: string },
  body: unknown,
  run: RunSkill,
): Promise<SkillResult<{ skill?: Record<string, unknown> | null; forgot?: boolean }>> {
  if (!task.url?.trim()) {
    return { ok: false, code: "NO_URL", error: "Set a start page for this task first: its steps belong to the page it starts on." };
  }
  const parts = parseCommandLine(s.jetCommand?.trim() || "clearcote-jet");
  const args = [...parts.slice(1), "skill", action, "--goal", normalizeTemplate(task.goal), "--url", task.url.trim()];
  let out: Awaited<ReturnType<RunSkill>>;
  try {
    out = await run(parts[0], args, body === undefined ? "" : JSON.stringify(body));
  } catch (e) {
    const code = (e as { code?: string })?.code;
    return {
      ok: false,
      code: "NO_JET",
      error: code === "ENOENT" ? `Jet is not installed or not found (${parts[0]}). Install it under Settings → Tasks.` : String((e as Error)?.message || e),
    };
  }
  if (/invalid choice: '?skill'?/.test(out.stderr)) return { ok: false, code: "JET_OLD", error: JET_OLD };
  const line = out.stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && "ok" in parsed) return parsed;
  } catch {
    /* fall through */
  }
  return { ok: false, error: `Jet did not answer (exit code ${out.code}). ${out.stderr.trim().split(/\r?\n/).slice(-3).join(" ")}`.trim() };
}

function toTaskSkill(raw: Record<string, unknown> | null | undefined): TaskSkill | null {
  if (!raw || !Array.isArray(raw.steps)) return null;
  return {
    steps: raw.steps as EditStep[],
    edited: !!raw.edited,
    ...(typeof raw.edited_at === "string" ? { editedAt: raw.edited_at } : {}),
    ...(typeof raw.learned_at === "string" ? { learnedAt: raw.learned_at } : {}),
  };
}

/** The steps the next run of this task replays; skill null when Jet has not learned it yet. */
export async function getTaskSkill(s: Pick<Settings, "jetCommand">, task: { goal: string; url?: string }, run: RunSkill = runProcess) {
  const r = await skill(s, "get", task, undefined, run);
  return r.ok ? { ok: true as const, skill: toTaskSkill(r.skill) } : r;
}

/** Save steps written by hand as what this task replays. */
export async function saveTaskSkill(s: Pick<Settings, "jetCommand">, task: { goal: string; url?: string }, steps: EditStep[], run: RunSkill = runProcess) {
  if (!Array.isArray(steps)) return { ok: false as const, error: "Steps must be a list." };
  const r = await skill(s, "put", task, { steps }, run);
  return r.ok ? { ok: true as const, skill: toTaskSkill(r.skill) } : r;
}

/** Forget the steps: the next run works the task out again and Jet learns it anew. */
export async function resetTaskSkill(s: Pick<Settings, "jetCommand">, task: { goal: string; url?: string }, run: RunSkill = runProcess) {
  const r = await skill(s, "forget", task, undefined, run);
  return r.ok ? { ok: true as const, forgot: !!r.forgot } : r;
}
