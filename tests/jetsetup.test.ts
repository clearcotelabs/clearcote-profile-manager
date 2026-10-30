// electron/jetsetup.ts — the Jet setup checklist (Python, Jet, model key) and the Jet install. Every program
// run and every HTTP call goes through an injected fake: nothing here starts Python or touches the network.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  pythonCandidates,
  findPython,
  probeJet,
  checkKey,
  jetStatus,
  installJet,
  isCustomCommand,
  JET_ZIP,
  type Exec,
  type PythonFound,
} from "../electron/jetsetup";

type Res = Awaited<ReturnType<Exec>>;
type Call = { cmd: string; args: string[]; opts?: Parameters<Exec>[2] };

/** An exec that answers by a function of the call, and records every call. */
function fakeExec(answer: (cmd: string, args: string[]) => Partial<Res>): Exec & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (cmd: string, args: string[], opts?: Parameters<Exec>[2]) => {
    calls.push({ cmd, args, opts });
    return { code: 0, out: "", err: "", ...answer(cmd, args) } as Res;
  }) as Exec & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const ready = (version: string) => JSON.stringify({ type: "ready", version }) + "\n";
const isWorker = (args: string[]) => args[args.length - 1] === "worker";

describe("pythonCandidates", () => {
  it("tries the py launcher first on Windows", () => {
    expect(pythonCandidates("win32")).toEqual([["py", "-3"], ["python"], ["python3"]]);
  });
  it("tries python3 then python elsewhere", () => {
    expect(pythonCandidates("linux")).toEqual([["python3"], ["python"]]);
    expect(pythonCandidates("darwin")).toEqual([["python3"], ["python"]]);
  });
});

describe("findPython", () => {
  it("picks the first candidate that answers with an exe and 3.10+", async () => {
    const exec = fakeExec((cmd) => (cmd === "py" ? { out: "C:\\Py\\python.exe\r\n3.12.4\r\n" } : { out: "/x\n3.13.0\n" }));
    expect(await findPython(exec, "win32")).toEqual({ cmd: ["py", "-3"], exe: "C:\\Py\\python.exe", version: "3.12.4" });
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].args.slice(0, 2)).toEqual(["-3", "-c"]);
  });

  it("skips 3.9, a missing program and the Store placeholder", async () => {
    const exec = fakeExec((cmd) => {
      if (cmd === "py") return { code: null, spawnError: "ENOENT" };
      if (cmd === "python") return { code: 9009, out: "" };
      return { out: "/usr/bin/python3\n3.9.18\n" };
    });
    expect(await findPython(exec, "win32")).toBeNull();
    expect(exec.calls.map((c) => c.cmd)).toEqual(["py", "python", "python3"]);
  });

  it("skips a 3.9 and takes the next 3.10", async () => {
    const exec = fakeExec((cmd) => (cmd === "python3" ? { out: "/a\n3.9.18\n" } : { out: "/b\n3.10.0\n" }));
    expect(await findPython(exec, "linux")).toEqual({ cmd: ["python"], exe: "/b", version: "3.10.0" });
  });

  it("does not accept an exit 0 with no output", async () => {
    const exec = fakeExec(() => ({ out: "" }));
    expect(await findPython(exec, "linux")).toBeNull();
  });
});

describe("probeJet", () => {
  it("reads the ready line and quotes a path with spaces", async () => {
    const exec = fakeExec(() => ({ out: "noise\n" + ready("0.3.1") }));
    const r = await probeJet(["C:\\Program Files\\Python312\\python.exe", "-m", "clearcote_jet.cli"], exec, {});
    expect(r).toEqual({ ok: true, version: "0.3.1", command: '"C:\\Program Files\\Python312\\python.exe" -m clearcote_jet.cli' });
    expect(exec.calls[0].cmd).toBe("C:\\Program Files\\Python312\\python.exe");
    expect(exec.calls[0].args).toEqual(["-m", "clearcote_jet.cli", "worker"]);
    expect(exec.calls[0].opts?.env?.PYTHONIOENCODING).toBe("utf-8");
  });

  it("a Jet older than 0.3.0 is old", async () => {
    const r = await probeJet(["clearcote-jet"], fakeExec(() => ({ out: ready("0.2.9") })), {});
    expect(r).toMatchObject({ ok: false, reason: "old", version: "0.2.9" });
  });

  it("a Jet with no worker command is old", async () => {
    const err = "usage: clearcote-jet ...\nclearcote-jet: error: argument cmd: invalid choice: 'worker' (choose from 'run')\n";
    const r = await probeJet(["clearcote-jet"], fakeExec(() => ({ code: 2, err })), {});
    expect(r).toMatchObject({ ok: false, reason: "old" });
  });

  it("a missing program or module is missing", async () => {
    expect(await probeJet(["clearcote-jet"], fakeExec(() => ({ code: null, spawnError: "ENOENT" })), {})).toEqual({ ok: false, reason: "missing" });
    const err = "C:\\Py\\python.exe: Error while finding module specification for 'clearcote_jet.cli' (ModuleNotFoundError: No module named clearcote_jet)";
    expect(await probeJet(["python", "-m", "clearcote_jet.cli"], fakeExec(() => ({ code: 1, err })), {})).toEqual({ ok: false, reason: "missing" });
    expect(await probeJet(["python", "-m", "clearcote_jet.cli"], fakeExec(() => ({ code: 1, err: "No module named 'clearcote_jet'" })), {})).toEqual({
      ok: false,
      reason: "missing",
    });
  });

  it("anything else is an error with a detail", async () => {
    const r = await probeJet(["clearcote-jet"], fakeExec(() => ({ code: 1, out: "garbage\n{not json", err: "Traceback\nValueError: boom\n" })), {});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("error");
    expect(r.detail).toMatch(/ValueError: boom/);
    const silent = await probeJet(["clearcote-jet"], fakeExec(() => ({ code: 1 })), {});
    expect(silent).toMatchObject({ ok: false, reason: "error", detail: "Jet did not answer." });
  });
});

describe("checkKey", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  });

  const fakeFetch = (status: number) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it("no key anywhere is missing, without a request", async () => {
    const { f, calls } = fakeFetch(200);
    expect(await checkKey(undefined, f)).toEqual({ ok: false, reason: "missing" });
    expect(await checkKey("   ", f)).toEqual({ ok: false, reason: "missing" });
    expect(calls).toHaveLength(0);
  });

  it("401 is rejected", async () => {
    expect(await checkKey("sk-bad", fakeFetch(401).f)).toEqual({ ok: false, reason: "rejected" });
  });

  it("422 means the key was accepted; sends POST with Bearer auth", async () => {
    const { f, calls } = fakeFetch(422);
    expect(await checkKey("  sk-good  ", f)).toEqual({ ok: true, source: "settings" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-good");
  });

  it("uses TYPESAFE_API_KEY when no key is given", async () => {
    process.env.TYPESAFE_API_KEY = "sk-env";
    const { f, calls } = fakeFetch(422);
    expect(await checkKey(undefined, f)).toEqual({ ok: true, source: "environment" });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sk-env");
  });

  it("a network failure or a 500 is an error", async () => {
    const throws = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkKey("sk", throws)).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/TypeError/) });
    expect(await checkKey("sk", fakeFetch(500).f)).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/500/) });
  });
});

describe("jetStatus", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = saved;
  });

  const fetchStatus = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
  const PY_EXE = "C:\\Program Files\\Python312\\python.exe";
  const pyAnswer = (args: string[]) => (args.includes("-c") ? { out: `${PY_EXE}\n3.12.4\n` } : null);

  it("saved command missing, python -m works: jet ok and fixedCommand set", async () => {
    const exec = fakeExec((cmd, args) => {
      const py = pyAnswer(args);
      if (py) return py;
      if (cmd === "clearcote-jet") return { code: null, spawnError: "ENOENT" };
      if (cmd === PY_EXE && isWorker(args)) return { out: ready("0.3.0") };
      return { code: 1 };
    });
    const s = await jetStatus({ jetApiKey: "sk" }, { exec, fetcher: fetchStatus(422), platform: "win32" });
    const cmdLine = `"${PY_EXE}" -m clearcote_jet.cli`;
    expect(s.jet).toEqual({ ok: true, version: "0.3.0", command: cmdLine });
    expect(s.fixedCommand).toBe(cmdLine);
    expect(s.python).toEqual({ cmd: ["py", "-3"], exe: PY_EXE, version: "3.12.4" });
    expect(s.ready).toBe(true);
  });

  it("fallback off (a command typed by hand): its own failure is reported, no fixedCommand", async () => {
    const exec = fakeExec((cmd, args) => {
      const py = pyAnswer(args);
      if (py) return py;
      if (cmd === "my-jet") return { code: null, spawnError: "ENOENT" };
      if (cmd === PY_EXE && isWorker(args)) return { out: ready("0.3.0") };
      return { code: 1 };
    });
    const s = await jetStatus({ jetCommand: "my-jet", jetApiKey: "sk" }, { exec, fetcher: fetchStatus(422), platform: "win32", fallback: false });
    expect(s.jet).toEqual({ ok: false, reason: "missing" });
    expect(s.fixedCommand).toBeUndefined();
    expect(s.ready).toBe(false);
  });

  it("saved command works but no key anywhere: jet ok, no fixedCommand, not ready", async () => {
    const exec = fakeExec((cmd, args) => pyAnswer(args) ?? (isWorker(args) ? { out: ready("0.4.0") } : { code: 1 }));
    const s = await jetStatus({ jetCommand: "clearcote-jet" }, { exec, fetcher: fetchStatus(200), platform: "linux" });
    expect(s.jet).toMatchObject({ ok: true, version: "0.4.0", command: "clearcote-jet" });
    expect(s.fixedCommand).toBeUndefined();
    expect(s.key).toEqual({ ok: false, reason: "missing" });
    expect(s.ready).toBe(false);
  });

  it("jet fine and a key accepted: ready", async () => {
    const exec = fakeExec((cmd, args) => pyAnswer(args) ?? (isWorker(args) ? { out: ready("0.4.0") } : { code: 1 }));
    const s = await jetStatus({ jetApiKey: "sk" }, { exec, fetcher: fetchStatus(200), platform: "linux" });
    expect(s.jet.ok).toBe(true);
    expect(s.key).toEqual({ ok: true, source: "settings" });
    expect(s.ready).toBe(true);
  });

  it("a rejected key: not ready", async () => {
    const exec = fakeExec((cmd, args) => pyAnswer(args) ?? (isWorker(args) ? { out: ready("0.4.0") } : { code: 1 }));
    const s = await jetStatus({ jetApiKey: "sk-bad" }, { exec, fetcher: fetchStatus(401), platform: "linux" });
    expect(s.jet.ok).toBe(true);
    expect(s.key).toEqual({ ok: false, reason: "rejected" });
    expect(s.ready).toBe(false);
  });
});

describe("installJet", () => {
  const py: PythonFound = { cmd: ["py", "-3"], exe: "C:\\Py\\python.exe", version: "3.12.4" };

  it("runs pip install --upgrade of Jet's main zip with the python command", async () => {
    const exec = fakeExec(() => ({ code: 0 }));
    expect(await installJet(py, exec)).toEqual({ ok: true });
    expect(exec.calls[0].cmd).toBe("py");
    expect(exec.calls[0].args).toEqual(["-3", "-m", "pip", "install", "--upgrade", "--disable-pip-version-check", JET_ZIP]);
    expect(JET_ZIP).toBe("https://github.com/clearcotelabs/clearcote-jet/archive/refs/heads/main.zip");
  });

  it("no pip: a friendly error", async () => {
    const r = await installJet(py, fakeExec(() => ({ code: 1, err: "C:\\Py\\python.exe: No module named pip\n" })));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/no pip/i) });
  });

  it("timeout: a friendly error", async () => {
    const r = await installJet(py, fakeExec(() => ({ code: null, spawnError: "timeout", out: "Collecting ...\n" })));
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/10 minutes/) });
  });

  it("other failure: the last lines of output", async () => {
    const err = "line1\nline2\n\nline3\nline4\nERROR: Could not install packages\n";
    const r = await installJet(py, fakeExec(() => ({ code: 1, err })));
    expect(r).toEqual({ ok: false, error: "line2\nline3\nline4\nERROR: Could not install packages" });
    expect(await installJet(py, fakeExec(() => ({ code: 3 })))).toEqual({ ok: false, error: "pip exited with code 3." });
  });
});

describe("isCustomCommand", () => {
  it("empty or the module form is not custom", () => {
    expect(isCustomCommand(undefined)).toBe(false);
    expect(isCustomCommand("  ")).toBe(false);
    expect(isCustomCommand('"C:\\Program Files\\Python312\\python.exe" -m clearcote_jet.cli')).toBe(false);
    expect(isCustomCommand("/usr/bin/python3 -m clearcote_jet.cli")).toBe(false);
  });
  it("anything else is custom", () => {
    expect(isCustomCommand("clearcote-jet")).toBe(true);
    expect(isCustomCommand("py -3 -m clearcote_jet.cli")).toBe(true);
    expect(isCustomCommand("python -m clearcote_jet")).toBe(true);
  });
});
