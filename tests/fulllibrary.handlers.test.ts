// The library handlers the desktop app and the helper share (electron/handlers.ts) with the full library added:
// its devices come after the curated samples (a device in both listed once), it still lists when the samples
// can't be fetched (it is kept on this computer), and a full-library device is used from the cache, never fetched.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const ROOT = vi.hoisted(() => {
  const req = require as (m: string) => unknown;
  const { mkdtempSync } = req("node:fs") as typeof import("node:fs");
  const { tmpdir } = req("node:os") as typeof import("node:os");
  return mkdtempSync(`${tmpdir()}/ccpm-fullhandlers-`);
});
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

// A device as the curated profile JSON has it (enough for summarizeFingerprint to accept it).
const device = (id: string, renderer: string) =>
  JSON.stringify({
    meta: { id, schema_version: 1 },
    hardware_concurrency: 8,
    device_memory: 8,
    screen: { width: 1920, height: 1080 },
    webgl: { webgl1: { debug: { UNMASKED_RENDERER_WEBGL: renderer }, parameters: {}, extensions: [] }, webgl2: { parameters: {} } },
  });
const FULL = "https://github.com/Vinyzu/chrome-fingerprints/blob/abc/chrome_fingerprints/fingerprints.json.xz#";
const fullRow = (id: string) => ({ name: `${id}.json`, downloadUrl: FULL + id, gpuVendor: "NVIDIA", renderer: "ANGLE (NVIDIA, X)", full: true });
const fullOn = { rows: [fullRow("vinyzu-00001"), fullRow("vinyzu-00002")] };

vi.mock("../electron/fullLibrary", () => ({
  list: () => fullOn.rows,
  status: () => ({ on: fullOn.rows.length > 0, count: fullOn.rows.length }),
  isFullUrl: (u: unknown) => typeof u === "string" && u.startsWith(FULL),
  readProfile: (u: string) => {
    if (!u.startsWith(FULL)) throw new Error("not full");
    return device(u.slice(FULL.length), "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
  },
  build: vi.fn(),
  remove: vi.fn(),
}));

const SAMPLES = { profiles: [{ id: "vinyzu-00001", gpu_vendor: "NVIDIA", renderer: "ANGLE (NVIDIA, sample)", screen: "1920x1080" }, { id: "vinyzu-00009", gpu_vendor: "Intel" }] };

async function handlers() {
  const { createHandlers } = await import("../electron/handlers");
  const host = { cloud: () => ({}) as never, changed() {}, openViewer: () => false, openPath: async () => "", openExternal() {} };
  return createHandlers(host);
}
const ctx = { emit() {} };

afterEach(() => vi.unstubAllGlobals());

describe("library handlers with the full library", () => {
  it("lists the samples, then the full library's devices that aren't samples", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(SAMPLES))));
    const h = await handlers();
    const r = (await h["fp:library"](ctx)) as { ok: boolean; profiles: { name: string; full?: boolean }[] };
    expect(r.ok).toBe(true);
    expect(r.profiles.map((p) => [p.name, !!p.full])).toEqual([
      ["vinyzu-00001.json", false], // the sample wins; its full-library twin is not listed again
      ["vinyzu-00009.json", false],
      ["vinyzu-00002.json", true],
    ]);
  });

  it("still lists the full library when the samples can't be fetched (offline)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const h = await handlers();
    const r = (await h["fp:library"](ctx)) as { ok: boolean; profiles: { name: string }[] };
    expect(r).toMatchObject({ ok: true });
    expect(r.profiles.map((p) => p.name)).toEqual(["vinyzu-00001.json", "vinyzu-00002.json"]);
  });

  it("uses a full-library device from the cache without fetching, stored like a sample", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const h = await handlers();
    const r = (await h["fp:use"](ctx, fullRow("vinyzu-00002"))) as { ok: boolean; file: string; meta: { source: string } };
    expect(r).toMatchObject({ ok: true, file: "vinyzu-00002.json", meta: { source: "library" } });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, "fingerprints", "vinyzu-00002.json"), "utf8")).meta.id).toBe("vinyzu-00002");
  });

  it("still refuses any other URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const h = await handlers();
    const r = (await h["fp:use"](ctx, { name: "x.json", downloadUrl: "https://example.com/x.json" })) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Only profiles from the clearcote-profiles library/);
  });

  it("reports the full library's state, and an add that fails says why", async () => {
    const fl = await import("../electron/fullLibrary");
    vi.mocked(fl.build).mockRejectedValueOnce(new Error("Downloading fingerprints.json.xz from Vinyzu/chrome-fingerprints failed (503)."));
    const h = await handlers();
    expect(await h["fp:fullLibrary"](ctx)).toEqual({ on: true, count: 2 });
    expect(await h["fp:fullLibrary:add"](ctx)).toMatchObject({ ok: false, on: true, error: expect.stringMatching(/failed \(503\)/) });
  });
});
