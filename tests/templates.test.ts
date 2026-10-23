import { describe, expect, it } from "vitest";
import {
  applyTemplate,
  describeTemplate,
  findTemplateByName,
  markUsed,
  nextNumber,
  profileFromTemplate,
  readTemplates,
  sortTemplates,
  suggestTemplateName,
  templateFromProfile,
  upsertTemplate,
  type ProfileTemplate,
} from "../src/lib/templates";
import { profilesFromProxyList } from "../src/lib/bulkCreate";
import { selectedModel } from "../src/lib/gpuPicker";
import type { Profile } from "../src/types/profile";

const NOW = "2026-10-23T10:00:00.000Z";

const source: Profile = {
  id: "shop-nl-4-ab12",
  name: "Shop NL 4",
  fingerprint: "oldseed123",
  platform: "windows",
  group: "Shop NL",
  tags: ["shop"],
  notes: "uses the NL store",
  screenWidth: 1920,
  screenHeight: 1080,
  availWidth: 1920,
  availHeight: 1032,
  hardwareConcurrency: 8,
  proxy: "http://u:p@gw.example.io:7777",
  geoip: true,
  timezone: "Europe/Amsterdam",
  acceptLanguage: "nl-NL",
  location: "52.37,4.89",
  webrtcIp: "81.2.3.4",
  gpuVendor: "Google Inc. (NVIDIA)",
  gpuRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  startUrl: "https://example.com",
  userDataDir: "C:/data/shop-nl-4",
  encryptionKey: "secret-key",
  lastLaunchedAt: NOW,
  lastGeo: { ip: "81.2.3.4", at: NOW, proxy: "x" },
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-02T00:00:00.000Z",
};

const tplAsk = templateFromProfile(source, { name: "Shop NL", proxy: "ask", gpu: "keep" }, NOW, "tpl-1");

describe("saving a template", () => {
  it("copies settings, never what makes the profile itself", () => {
    const b = tplAsk.base as Record<string, unknown>;
    for (const k of ["id", "name", "fingerprint", "userDataDir", "encryptionKey", "lastLaunchedAt", "lastGeo", "createdAt", "updatedAt"]) {
      expect(k in b, k).toBe(false);
    }
    expect(b.screenWidth).toBe(1920);
    expect(b.group).toBe("Shop NL");
    expect(b.startUrl).toBe("https://example.com");
    expect(tplAsk.sourceName).toBe("Shop NL 4");
  });

  it("with the proxy asked, drops the proxy and everything that describes where it exits", () => {
    const b = tplAsk.base as Record<string, unknown>;
    for (const k of ["proxy", "timezone", "acceptLanguage", "location", "webrtcIp"]) expect(k in b, k).toBe(false);
  });

  it("with the same proxy, keeps the proxy and its region", () => {
    const t = templateFromProfile(source, { name: "Same", proxy: "keep", gpu: "keep" }, NOW, "tpl-2");
    expect(t.base.proxy).toBe(source.proxy);
    expect(t.base.timezone).toBe("Europe/Amsterdam");
  });

  it("suggests the group, else the name without its number", () => {
    expect(suggestTemplateName(source)).toBe("Shop NL");
    expect(suggestTemplateName({ ...source, group: undefined, name: "Test A 12" })).toBe("Test A");
    expect(suggestTemplateName({ ...source, group: undefined, name: "Research copy" })).toBe("Research");
  });

  it("saving again under the same name replaces it and keeps its id and use count", () => {
    const used = markUsed([tplAsk], "tpl-1", NOW, 5);
    const again = templateFromProfile({ ...source, hardwareConcurrency: 16 }, { name: "shop nl", proxy: "ask", gpu: "fresh" }, NOW, "tpl-9");
    const list = upsertTemplate(used, again, "2026-10-24T00:00:00.000Z");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("tpl-1");
    expect(list[0].usedCount).toBe(5);
    expect(list[0].gpu).toBe("fresh");
    expect(list[0].base.hardwareConcurrency).toBe(16);
    expect(findTemplateByName(list, "SHOP NL")?.id).toBe("tpl-1");
  });
});

describe("a new profile from a template", () => {
  it("gets a new seed, no id, a numbered name and the template's settings", () => {
    const p = profileFromTemplate(tplAsk, { seed: "newseed", now: NOW, number: 15 });
    expect(p.id).toBe("");
    expect(p.name).toBe("Shop NL 15");
    expect(p.fingerprint).toBe("newseed");
    expect(p.screenHeight).toBe(1080);
    expect(p.gpuRenderer).toBe(source.gpuRenderer);
    expect(p.userDataDir).toBeUndefined();
    expect(p.encryptionKey).toBeUndefined();
    expect(p.proxy).toBeUndefined();
    expect(p.geoip).toBe(true);
    expect(p.createdAt).toBe(NOW);
  });

  it("a fresh-GPU template picks another model of this computer's maker", () => {
    const t = { ...tplAsk, gpu: "fresh" as const };
    const before = selectedModel(source);
    const p = profileFromTemplate(t, { seed: "s", now: NOW, number: 1, hostVendor: "nvidia", rnd: () => 0.5 });
    const after = selectedModel(p);
    expect(after).toBeTruthy();
    expect(after?.vendor).toBe("nvidia");
    expect(after?.name).not.toBe(before?.name);
  });

  it("leaves the GPU alone on platforms the model table does not cover", () => {
    const mac = templateFromProfile({ ...source, platform: "macos" }, { name: "Mac", proxy: "ask", gpu: "fresh" }, NOW, "m");
    expect(profileFromTemplate(mac, { seed: "s", now: NOW, number: 1, hostVendor: "nvidia" }).gpuRenderer).toBe(source.gpuRenderer);
  });

  it("numbers on from the profiles already named after it", () => {
    expect(nextNumber(tplAsk, ["Shop NL 3", "shop nl 14", "Shop NL copy", "Other 99"])).toBe(15);
    expect(nextNumber({ name: "A (test)" }, ["A (test) 2"])).toBe(3);
    expect(nextNumber(tplAsk, [])).toBe(1);
  });
});

describe("a proxy list with a template", () => {
  it("each profile keeps its own name, seed and proxy, and takes everything else from the template", () => {
    const t = templateFromProfile(source, { name: "Shop NL", proxy: "keep", gpu: "keep" }, NOW, "t");
    const listed = profilesFromProxyList("1.2.3.4:8080:u:p\n5.6.7.8:8080:u:p", { namePattern: "Shop NL {n}", geoip: true, startAt: 5 }, []).profiles;
    const out = listed.map((p) => applyTemplate(p, t));
    expect(out.map((p) => p.name)).toEqual(["Shop NL 5", "Shop NL 6"]);
    expect(out[0].proxy).toContain("1.2.3.4:8080");
    expect(out[1].proxy).toContain("5.6.7.8:8080");
    expect(out[0].fingerprint).not.toBe(out[1].fingerprint);
    expect(out[0].timezone).toBeUndefined(); // the template's region belongs to its own proxy
    expect(out[0].screenWidth).toBe(1920);
    expect(out[0].group).toBe("Shop NL"); // the template's, since the list set none
    expect(out[0].id).toBe(listed[0].id);
  });

  it("group and tags typed in the dialog override the template's", () => {
    const listed = profilesFromProxyList("1.2.3.4:8080", { namePattern: "X {n}", geoip: true, group: "DE", tags: ["new"] }, []).profiles;
    const p = applyTemplate(listed[0], tplAsk);
    expect(p.group).toBe("DE");
    expect(p.tags).toEqual(["new"]);
  });
});

describe("the list", () => {
  it("sorts most recently used first, then most used, then by name", () => {
    const a = { ...tplAsk, id: "a", name: "B", usedCount: 9 };
    const b = { ...tplAsk, id: "b", name: "A", usedCount: 1, lastUsedAt: NOW };
    const c = { ...tplAsk, id: "c", name: "C", usedCount: 9 };
    expect(sortTemplates([a, c, b]).map((t) => t.id)).toEqual(["b", "a", "c"]);
  });

  it("describes a template in a few words", () => {
    expect(describeTemplate({ ...tplAsk, gpu: "fresh", usedCount: 3 })).toBe("asks proxy · new GPU · used 3×");
    expect(describeTemplate({ ...tplAsk, proxy: "keep" })).toBe("same proxy · same GPU");
  });

  it("reads stored templates defensively", () => {
    const raw = [tplAsk, null, { id: 1 }, { id: "x", name: "No base" }, { ...tplAsk, id: "y", proxy: "weird", gpu: 7 }];
    const list = readTemplates(raw);
    expect(list.map((t) => t.id)).toEqual(["tpl-1", "y"]);
    expect(list[1].proxy).toBe("ask");
    expect(list[1].gpu).toBe("keep");
    expect(readTemplates(undefined)).toEqual([]);
    expect(readTemplates("nope")).toEqual([]);
  });

  it("round-trips through JSON as settings.json stores it", () => {
    const list: ProfileTemplate[] = JSON.parse(JSON.stringify([tplAsk]));
    expect(readTemplates(list)[0]).toEqual(tplAsk);
  });
});
