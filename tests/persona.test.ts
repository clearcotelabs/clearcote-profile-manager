// Server-side personas (r51): the launcher-side half, against a fake persona service.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  API_ENV, PersonaServiceError, TOKEN_ENV, TOKEN_GZ_ENV, clearPersonaCaches, engineSupportsSwitch, fetchPersonaToken,
  injectPersonaToken, preparePersonaLaunch, selectorFromArgs,
} from "../electron/persona";

const R51 = (_bin: string, name: string) => name === "cc-persona-host-facts";
const OLD = () => false;

class FakeService {
  requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  server: Server;
  base = "";
  constructor(public status = 200) {
    this.server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => { data += c; });
      req.on("end", () => {
        const body = JSON.parse(data);
        this.requests.push({ path: req.url ?? "", body });
        const out = this.status === 200
          ? { persona_token: "tok-" + createHash("sha256").update(JSON.stringify(body.sel)).digest("hex").slice(0, 12), exp: Date.now() / 1000 + 3600 }
          : { error: `refused ${this.status}` };
        res.writeHead(this.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out));
      });
    });
  }
  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(0, "127.0.0.1", () => {
      const a = this.server.address();
      this.base = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
      r();
    }));
  }
  close(): void { this.server.close(); }
}

describe("server-side personas (r51)", () => {
  let svc: FakeService;
  let dir: string;
  let bin: string;
  let runnerCalls: Array<{ cmd: string[]; env: NodeJS.ProcessEnv }>;
  const runner = (cmd: string[], env: NodeJS.ProcessEnv) => { runnerCalls.push({ cmd, env }); return 'ignored\n{"gpu_vendor":"nvidia"}\n'; };
  const lease = { token: "hdr.sig", leaseId: "L1" };

  beforeEach(async () => {
    svc = new FakeService();
    await svc.listen();
    process.env[API_ENV] = svc.base;
    dir = mkdtempSync(join(tmpdir(), "cc-persona-"));
    bin = join(dir, "chrome");
    writeFileSync(bin, "x");
    runnerCalls = [];
    clearPersonaCaches();
  });
  afterEach(() => {
    svc.close();
    delete process.env[API_ENV];
    rmSync(dir, { recursive: true, force: true });
    clearPersonaCaches();
  });
  const deps = () => ({ supports: R51, runner, env: { HOME: dir, LOCALAPPDATA: dir } });

  it("probes the binary for the r51 marker switch, NUL-delimited", () => {
    const yes = join(dir, "r51");
    writeFileSync(yes, Buffer.from("abc\0cc-persona-host-facts\0def", "latin1"));
    const no = join(dir, "r50");
    writeFileSync(no, Buffer.from("abc cc-persona-host-facts def", "latin1"));
    expect(engineSupportsSwitch(yes, "cc-persona-host-facts")).toBe(true);
    expect(engineSupportsSwitch(no, "cc-persona-host-facts")).toBe(false);
    expect(engineSupportsSwitch(join(dir, "missing"), "cc-persona-host-facts")).toBe(false);
  });

  it("keeps only the generator's switches, last value wins, canvas-bridge-url is presence", () => {
    const { sel, profileJson, args } = selectorFromArgs(["--headless", "--fingerprint=1", "--fingerprint=2", "--lang=en-US",
      "--fingerprint-platform=windows", "--canvas-bridge-url=ws://x:1?auth=s", "--disable-gpu-string-spoof", "--user-data-dir=/tmp/u"]);
    expect(sel).toEqual({ fingerprint: "2", "fingerprint-platform": "windows", "canvas-bridge-url": "1", "disable-gpu-string-spoof": "" });
    expect(profileJson).toBeNull();
    expect(args.at(-1)).toBe("--user-data-dir=/tmp/u");
  });

  it("moves a captured profile off argv and names it by sha256", () => {
    const text = JSON.stringify({ screen: { width: 1920 } });
    const b64 = gzipSync(Buffer.from(text)).toString("base64");
    const { sel, profileJson, args } = selectorFromArgs(["--fingerprint=7", `--fingerprint-profile=${b64}`]);
    const sha = createHash("sha256").update(text).digest("hex");
    expect(profileJson).toBe(text);
    expect(sel["fingerprint-profile-sha256"]).toBe(sha);
    expect(args).toEqual(["--fingerprint=7", `--fingerprint-profile-sha256=${sha}`]);
  });

  it("leaves an old engine and a free launch alone", async () => {
    const a = await preparePersonaLaunch(bin, ["--fingerprint=1"], lease, { supports: OLD });
    expect(a.args).toEqual(["--fingerprint=1"]);
    expect(a.env({ A: "1" })).toEqual({ A: "1" });
    const b = await preparePersonaLaunch(bin, ["--fingerprint=1"], null, { supports: R51 });
    expect(b.env(undefined)).toBeUndefined();
    expect(svc.requests).toHaveLength(0);
  });

  it("fetches with the selector and host facts and injects the token", async () => {
    const p = await preparePersonaLaunch(bin, ["--headless", "--fingerprint=42", "--fingerprint-platform=linux"], lease, deps());
    expect(p.args).toEqual(["--headless", "--fingerprint=42", "--fingerprint-platform=linux"]);
    expect(p.env({ PATH: "/bin" })).toMatchObject({ PATH: "/bin", [TOKEN_ENV]: expect.stringMatching(/^tok-/) });
    expect(svc.requests[0]).toEqual({ path: "/v1/persona", body: { token: "hdr.sig", sel: { fingerprint: "42", "fingerprint-platform": "linux" }, host: { gpu_vendor: "nvidia" } } });
    expect(runnerCalls[0].cmd).toEqual([bin, "--cc-persona-host-facts", "--headless"]);
    expect(runnerCalls[0].env.CLEARCOTE_RUN_TOKEN).toBe("hdr.sig");
  });

  it("fetches a default persona for a seedless launch", async () => {
    const p = await preparePersonaLaunch(bin, ["--fingerprint-platform=windows", "--window-size=1,1"], lease, deps());
    expect(svc.requests[0].body.sel).toEqual({ "fingerprint-platform": "windows" });
    expect(p.env({})?.[TOKEN_ENV]).toMatch(/^tok-/);
  });

  it("caches tokens per lease + selector and host facts per binary", async () => {
    for (let i = 0; i < 3; i++) await preparePersonaLaunch(bin, ["--fingerprint=5"], lease, deps());
    await preparePersonaLaunch(bin, ["--fingerprint=6"], lease, deps());
    await preparePersonaLaunch(bin, ["--fingerprint=5"], { token: "hdr.sig", leaseId: "L2" }, deps());
    expect(svc.requests).toHaveLength(3);
    expect(runnerCalls).toHaveLength(1);
  });

  it("uploads a profile as its exact text", async () => {
    const text = '{"screen":{"width":1366},"b":1.0}';
    const b64 = gzipSync(Buffer.from(text)).toString("base64");
    const p = await preparePersonaLaunch(bin, [`--fingerprint-profile=${b64}`], lease, deps());
    const sha = createHash("sha256").update(text).digest("hex");
    expect(svc.requests[0].body.profile_json).toBe(text);
    expect(svc.requests[0].body.sel).toEqual({ "fingerprint-profile-sha256": sha });
    expect(p.args).toEqual([`--fingerprint-profile-sha256=${sha}`]);
  });

  it("raises clear errors on refusal and on an unreachable service", async () => {
    svc.status = 429;
    await expect(preparePersonaLaunch(bin, ["--fingerprint=1"], lease, deps())).rejects.toThrow(/refused this launch: refused 429/);
    await expect(fetchPersonaToken("t", { fingerprint: "1" }, { gpu_vendor: "none" }, null, ["http://127.0.0.1:9"], 500)).rejects.toThrow(PersonaServiceError);
  });

  it("gives the host-facts probe the launch env, run-token FILE included (a free token is refused without it)", async () => {
    const env = { HOME: dir, LOCALAPPDATA: dir, CLEARCOTE_RUN_TOKEN: "hdr.sig", CLEARCOTE_RUN_TOKEN_FILE: join(dir, "run.tok") };
    await preparePersonaLaunch(bin, ["--fingerprint=7"], lease, { supports: R51, runner, env });
    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0].env.CLEARCOTE_RUN_TOKEN_FILE).toBe(join(dir, "run.tok"));
    expect(runnerCalls[0].env.CLEARCOTE_RUN_TOKEN).toBe("hdr.sig");
  });

  it("raises when the engine does not report its host facts", async () => {
    await expect(preparePersonaLaunch(bin, ["--fingerprint=1"], lease, { ...deps(), runner: () => "not json" })).rejects.toThrow(/host facts/);
    expect(svc.requests).toHaveLength(0);
  });

  it("gzips a long token", () => {
    const env = injectPersonaToken({}, "a".repeat(40000));
    expect(env[TOKEN_ENV]).toBeUndefined();
    expect(gunzipSync(Buffer.from(env[TOKEN_GZ_ENV]!, "base64")).toString()).toBe("a".repeat(40000));
    expect(injectPersonaToken(env, "short")).toEqual({ [TOKEN_ENV]: "short" });
  });
});
