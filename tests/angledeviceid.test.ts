// The device id added to an old capture's WebGL renderer (CR-LYJSFW 11-05).
import { describe, it, expect } from "vitest";
import { withAngleDeviceId, fixCaptureRenderers, captureForEngine } from "../electron/angledeviceid";
import { BY_ARCH, BY_NAME } from "../electron/angledeviceids.generated";

const OLD_4070TI = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)";
const NEW_4070TI = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)";

describe("withAngleDeviceId", () => {
  it("adds the id real captures of the card print, in ANGLE's own format", () => {
    expect(withAngleDeviceId(OLD_4070TI)).toBe(NEW_4070TI);
    expect(withAngleDeviceId(OLD_4070TI, "lovelace")).toBe(NEW_4070TI);
  });

  it("keeps a renderer that already has an id", () => {
    expect(withAngleDeviceId(NEW_4070TI)).toBe(NEW_4070TI);
  });

  it("keeps renderers that are not Direct3D 11", () => {
    const gl = "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 4070 Ti/PCIe/SSE2, OpenGL 4.5.0)";
    expect(withAngleDeviceId(gl)).toBe(gl);
    expect(withAngleDeviceId("")).toBe("");
  });

  it("keeps a card the table does not know", () => {
    const odd = "ANGLE (NVIDIA, NVIDIA GeForce Imaginary 9999 Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(withAngleDeviceId(odd)).toBe(odd);
  });

  it("picks an id of the capture's chip generation for a generic name", () => {
    const amd = "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)";
    expect(withAngleDeviceId(amd, "gcn-5")).toBe(amd.replace(" Direct3D11", ` (${BY_ARCH["AMD|AMD Radeon(TM) Graphics|gcn-5"]}) Direct3D11`));
    // An architecture the table never saw for that name falls back to the name's most common id.
    expect(withAngleDeviceId(amd, "no-such-arch")).toBe(amd.replace(" Direct3D11", ` (${BY_NAME["AMD|AMD Radeon(TM) Graphics"]}) Direct3D11`));
  });

  it("keeps the Direct3D11on12 and shader-model tail as captured", () => {
    const on12 = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11on12 vs_5_0 ps_5_0, D3D11)";
    expect(withAngleDeviceId(on12)).toBe("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11on12 vs_5_0 ps_5_0, D3D11)");
  });

  it("every table id has ANGLE's 8-digit uppercase form", () => {
    for (const id of [...Object.values(BY_ARCH), ...Object.values(BY_NAME)]) expect(id).toMatch(/^0x[0-9A-F]{8}$/);
  });
});

describe("fixCaptureRenderers / captureForEngine", () => {
  const capture = () => ({
    webgl: {
      webgl1: { debug: { UNMASKED_VENDOR_WEBGL: "Google Inc. (NVIDIA)", UNMASKED_RENDERER_WEBGL: OLD_4070TI } },
      webgl2: { debug: { UNMASKED_VENDOR_WEBGL: "Google Inc. (NVIDIA)", UNMASKED_RENDERER_WEBGL: OLD_4070TI } },
    },
    webgpu: { high_performance: { info: { vendor: "nvidia", architecture: "lovelace" } } },
    navigator: { languages: ["nl-NL", "nl"] },
  });

  it("fixes both WebGL contexts and leaves the rest of the capture alone", () => {
    const c = capture();
    expect(fixCaptureRenderers(c)).toBe(true);
    expect(c.webgl.webgl1.debug.UNMASKED_RENDERER_WEBGL).toBe(NEW_4070TI);
    expect(c.webgl.webgl2.debug.UNMASKED_RENDERER_WEBGL).toBe(NEW_4070TI);
    expect(c.webgl.webgl1.debug.UNMASKED_VENDOR_WEBGL).toBe("Google Inc. (NVIDIA)");
    expect(c.navigator.languages).toEqual(["nl-NL", "nl"]);
    expect(fixCaptureRenderers(c)).toBe(false);
  });

  it("hands the engine fixed JSON, and an unchanged or unreadable file byte for byte", () => {
    const out = JSON.parse(captureForEngine(Buffer.from(JSON.stringify(capture()))).toString("utf8"));
    expect(out.webgl.webgl2.debug.UNMASKED_RENDERER_WEBGL).toBe(NEW_4070TI);

    const good = capture();
    fixCaptureRenderers(good);
    const raw = Buffer.from(JSON.stringify(good, null, 2));
    expect(captureForEngine(raw)).toBe(raw);
    const junk = Buffer.from("not json");
    expect(captureForEngine(junk)).toBe(junk);
    expect(fixCaptureRenderers({} as Record<string, unknown>)).toBe(false);
  });
});
