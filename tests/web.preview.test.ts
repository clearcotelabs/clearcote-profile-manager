import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pickHelperRelease, downloadFor, type GhRelease } from "../src/lib/helperRelease";
import { buildPreviewApi, switchable, needsHelper, NEED_HELPER_EVENT, NEEDS_HELPER } from "../src/lib/webPreview";
import type { ClearcoteApi } from "../src/lib/ipc";

const asset = (name: string) => ({ name, browser_download_url: `https://example.test/${name}`, size: 34_000_000 });

describe("pickHelperRelease", () => {
  const list: GhRelease[] = [
    { tag_name: "v0.21.0", html_url: "desktop", assets: [asset("Clearcote-Profile-Manager-0.21.0-setup.exe")] },
    { tag_name: "helper-v0.21.0", html_url: "draft", draft: true, assets: [] },
    {
      tag_name: "helper-v0.20.0",
      html_url: "https://github.com/x/releases/tag/helper-v0.20.0",
      assets: [
        asset("SHA256SUMS"),
        asset("clearcote-helper-0.20.0-linux-x64.tar.gz"),
        asset("clearcote-helper-0.20.0-mac-x64.tar.gz"),
        asset("clearcote-helper-0.20.0-mac-arm64.tar.gz"),
        asset("clearcote-helper-0.20.0-win-arm64.zip"),
        asset("clearcote-helper-0.20.0-win-x64.zip"),
      ],
    },
  ];

  it("skips the desktop release and drafts, takes the newest helper release", () => {
    const r = pickHelperRelease(list)!;
    expect(r.version).toBe("0.20.0");
    expect(r.page).toContain("helper-v0.20.0");
    expect(r.downloads.map((d) => d.label)).toEqual(["Windows", "Windows on Arm", "macOS, Apple Silicon", "macOS, Intel", "Linux x64"]);
    expect(r.downloads[0].sizeMB).toBe(34);
  });

  it("is null when there is no helper release, or the answer is not a list", () => {
    expect(pickHelperRelease([list[0]])).toBeNull();
    expect(pickHelperRelease({ message: "rate limited" } as unknown as GhRelease[])).toBeNull();
  });

  it("picks the file for this computer", () => {
    const r = pickHelperRelease(list)!;
    expect(downloadFor(r, "Windows")!.url).toMatch(/win-x64\.zip$/);
    expect(downloadFor(r, "Windows", "arm64")!.url).toMatch(/win-arm64\.zip$/);
    expect(downloadFor(r, "macOS")!.url).toMatch(/mac-arm64/); // unknown CPU on a Mac: Apple Silicon
    expect(downloadFor(r, "macOS", "x64")!.url).toMatch(/mac-x64/);
    expect(downloadFor(r, "Linux", "arm64")!.url).toMatch(/linux-x64/); // no arm64 file: the one there is
  });
});

describe("the web preview", () => {
  const events: string[] = [];
  beforeEach(() => {
    events.length = 0;
    const target = new EventTarget();
    target.addEventListener(NEED_HELPER_EVENT, (e) => events.push(String((e as CustomEvent).detail)));
    vi.stubGlobal("window", target);
  });
  afterEach(() => vi.unstubAllGlobals());

  const mock = {
    profiles: { list: async () => [{ id: "a" }], openData: async () => ({ ok: true }), clearCache: async () => ({ ok: true }) },
    storage: { plan: async () => ({}), prefetch: async () => ({ ok: true }) },
    cloud: { list: async () => [], start: async () => ({ ok: true }), account: async () => ({ ok: true }) },
    settings: { get: async () => ({ theme: "dark" }), set: async () => ({ theme: "light" }) },
    fp: { library: async () => ({ ok: true }), import: async () => ({ ok: true }), use: async () => ({ ok: true }) },
    launch: async () => ({ ok: true }),
  } as unknown as ClearcoteApi;

  it("asks for the helper instead of launching, and says why", async () => {
    const api = buildPreviewApi(mock);
    const r = await api.launch({ id: "a" } as never);
    expect(r).toMatchObject({ ok: false, code: NEEDS_HELPER });
    expect(needsHelper(r)).toBe(true);
    expect(events).toEqual(["launch a browser"]);
  });

  it("keeps browsing in the preview, and never stores settings in the browser", async () => {
    const api = buildPreviewApi(mock);
    expect(await api.profiles.list()).toEqual([{ id: "a" }]);
    expect(await api.settings.set({ theme: "light", licenseKey: "cc_lic_x" } as never)).toEqual({ theme: "dark" });
    expect(events).toEqual(["save settings"]);
    expect((await api.launchTarget()).mode).toBe("preview");
  });

  it("switchable sends each call to whichever side is current", async () => {
    let live = false;
    const a = { profiles: { list: async () => ["preview"] }, n: 1 };
    const b = { profiles: { list: async () => ["helper"] }, n: 2 };
    const api = switchable(() => (live ? b : a));
    const list = api.profiles.list; // held by a component across the switch
    expect(await list()).toEqual(["preview"]);
    live = true;
    expect(await list()).toEqual(["helper"]);
    expect(api.n).toBe(2);
  });
});

describe("the built-in helper release (no API needed)", () => {
  it("builds every download link from the version", async () => {
    const { builtHelperRelease } = await import("../src/lib/helperRelease");
    const r = builtHelperRelease("0.20.1")!;
    expect(r.page).toBe("https://github.com/clearcotelabs/clearcote-profile-manager/releases/tag/helper-v0.20.1");
    expect(r.downloads.map((d) => d.url.split("/").pop())).toEqual([
      "clearcote-helper-0.20.1-win-x64.zip",
      "clearcote-helper-0.20.1-win-arm64.zip",
      "clearcote-helper-0.20.1-mac-arm64.tar.gz",
      "clearcote-helper-0.20.1-mac-x64.tar.gz",
      "clearcote-helper-0.20.1-linux-x64.tar.gz",
      "clearcote-helper-0.20.1-linux-arm64.tar.gz",
    ]);
    expect(builtHelperRelease("")).toBeNull();
  });

  it("takes GitHub's answer only when it is not older", async () => {
    const { builtHelperRelease, bestHelperRelease } = await import("../src/lib/helperRelease");
    const built = builtHelperRelease("0.20.1");
    const api = (v: string) => ({ version: v, page: "p", downloads: [] });
    expect(bestHelperRelease(null, built)?.version).toBe("0.20.1");
    expect(bestHelperRelease(api("0.21.0"), built)?.version).toBe("0.21.0");
    expect(bestHelperRelease(api("0.20.0"), built)?.version).toBe("0.20.1");
    expect(bestHelperRelease(api("0.20.0"), null)?.version).toBe("0.20.0");
  });
});
