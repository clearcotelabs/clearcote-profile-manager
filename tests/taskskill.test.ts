// electron/taskskill.ts — reading, saving and forgetting a task's steps through `clearcote-jet skill`, with the
// process faked: the arguments it gets, what it is sent, and how each kind of failure reads.

import { describe, it, expect } from "vitest";
import { getTaskSkill, resetTaskSkill, saveTaskSkill, usesJavaScript, type EditStep, type RunSkill } from "../electron/taskskill";

const TASK = { goal: "  Search for {{ query }} ", url: "https://shop.example/" };

function fake(answer: Partial<{ code: number; stdout: string; stderr: string }> | Error) {
  const calls: { cmd: string; args: string[]; stdin: string }[] = [];
  const run: RunSkill = async (cmd, args, stdin) => {
    calls.push({ cmd, args, stdin });
    if (answer instanceof Error) throw answer;
    return { code: 0, stdout: "", stderr: "", ...answer };
  };
  return { run, calls };
}

describe("taskskill", () => {
  it("asks Jet for the skill keyed as a run keys it, and reads the steps", async () => {
    const f = fake({ stdout: JSON.stringify({ ok: true, skill: { steps: [{ kind: "click", label: "Go" }], edited: true, edited_at: "2026-10-31T10:00:00+00:00" } }) });
    const r = await getTaskSkill({ jetCommand: '"C:\\Py 3\\python.exe" -m clearcote_jet.cli' }, TASK, f.run);
    expect(r).toEqual({ ok: true, skill: { steps: [{ kind: "click", label: "Go" }], edited: true, editedAt: "2026-10-31T10:00:00+00:00" } });
    expect(f.calls[0].cmd).toBe("C:\\Py 3\\python.exe");
    expect(f.calls[0].args).toEqual(["-m", "clearcote_jet.cli", "skill", "get", "--goal", "Search for {{query}}", "--url", "https://shop.example/"]);
  });

  it("not learned yet is skill null", async () => {
    expect(await getTaskSkill({}, TASK, fake({ stdout: '{"ok": true, "skill": null}\n' }).run)).toEqual({ ok: true, skill: null });
  });

  it("sends the steps to put, and passes Jet's own refusal on", async () => {
    const steps: EditStep[] = [{ kind: "goto", url: "https://shop.example/a" }];
    const f = fake({ stdout: JSON.stringify({ ok: true, skill: { steps, edited: true } }) });
    expect(await saveTaskSkill({}, TASK, steps, f.run)).toMatchObject({ ok: true, skill: { steps, edited: true } });
    expect(f.calls[0].args.slice(0, 2)).toEqual(["skill", "put"]);
    expect(JSON.parse(f.calls[0].stdin)).toEqual({ steps });
    const no = fake({ stdout: '{"ok": false, "error": "step 1: unknown kind \'x\'"}' });
    expect(await saveTaskSkill({}, TASK, [{ kind: "x" as never }], no.run)).toEqual({ ok: false, error: "step 1: unknown kind 'x'" });
  });

  it("forget", async () => {
    const f = fake({ stdout: '{"ok": true, "forgot": true}' });
    expect(await resetTaskSkill({}, TASK, f.run)).toEqual({ ok: true, forgot: true });
    expect(f.calls[0].args.slice(0, 2)).toEqual(["skill", "forget"]);
  });

  it("a task with no start page, an old Jet, no Jet, and a crash each say what to do", async () => {
    expect(await getTaskSkill({}, { goal: "x" }, fake({}).run)).toMatchObject({ ok: false, code: "NO_URL" });
    const old = fake({ code: 2, stderr: "clearcote-jet: error: argument command: invalid choice: 'skill' (choose from 'browser', 'run', 'read', 'worker')" });
    expect(await getTaskSkill({}, TASK, old.run)).toMatchObject({ ok: false, code: "JET_OLD", error: expect.stringMatching(/0\.5\.0/) });
    const missing = fake(Object.assign(new Error("spawn clearcote-jet ENOENT"), { code: "ENOENT" }));
    expect(await getTaskSkill({}, TASK, missing.run)).toMatchObject({ ok: false, code: "NO_JET", error: expect.stringMatching(/not installed/) });
    const crash = fake({ code: 1, stderr: "Traceback...\nModuleNotFoundError: No module named 'clearcote'" });
    expect(await getTaskSkill({}, TASK, crash.run)).toMatchObject({ ok: false, error: expect.stringMatching(/exit code 1.*No module named/) });
  });

  it("usesJavaScript finds a JavaScript step or condition at any depth", () => {
    expect(usesJavaScript([{ kind: "click", label: "a" }])).toBe(false);
    expect(usesJavaScript([{ kind: "if", condition: { type: "text", value: "x" }, then: [], else: [{ kind: "js", code: "1" }] }])).toBe(true);
    expect(usesJavaScript([{ kind: "while", condition: { type: "js", value: "true" }, then: [] }])).toBe(true);
  });
});
