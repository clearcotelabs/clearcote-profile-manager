// Captured profiles from Chrome before ~118 carry a Windows WebGL renderer with no PCI device id:
//   ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti Direct3D11 vs_5_0 ps_5_0, D3D11)
// Chromium 156 always prints the id, "(0x%08X)" before "Direct3D11", so the engine showing the old
// shape is a string it cannot produce (the /audit row webgl-renderer-angle-format flags it,
// CR-LYJSFW 11-05). These add the id real captures of the same card print. Pure, so tests pin it.

import { BY_ARCH, BY_NAME } from "./angledeviceids.generated";

const NO_ID = /^ANGLE \(([^,]+), (.+?) (Direct3D11(?:on12)? vs_\d_\d ps_\d_\d, D3D11\))$/;

/** The renderer with the device id ANGLE prints for that card, or the string unchanged when it has
 *  one already, is not a Direct3D 11 renderer, or the card is not in the table. `arch` is the
 *  capture's WebGPU architecture: it picks an id of the same chip generation for a generic name. */
export function withAngleDeviceId(renderer: string, arch = ""): string {
  if (renderer.includes("(0x")) return renderer;
  const m = NO_ID.exec(renderer);
  if (!m) return renderer;
  const [, vendor, name, tail] = m;
  const id = BY_ARCH[`${vendor}|${name}|${arch}`] ?? BY_NAME[`${vendor}|${name}`];
  return id ? `ANGLE (${vendor}, ${name} (${id}) ${tail}` : renderer;
}

/** A parsed capture with every WebGL renderer given its device id. Returns true when it changed. */
export function fixCaptureRenderers(capture: Record<string, unknown>): boolean {
  const webgl = capture?.webgl as Record<string, { debug?: Record<string, unknown> }> | undefined;
  if (!webgl || typeof webgl !== "object") return false;
  const webgpu = capture.webgpu as { high_performance?: { info?: { architecture?: unknown } } } | undefined;
  const arch = typeof webgpu?.high_performance?.info?.architecture === "string" ? webgpu.high_performance.info.architecture : "";
  let changed = false;
  for (const ctx of ["webgl1", "webgl2"]) {
    const debug = webgl[ctx]?.debug;
    const r = debug?.UNMASKED_RENDERER_WEBGL;
    if (!debug || typeof r !== "string") continue;
    const fixed = withAngleDeviceId(r, arch);
    if (fixed !== r) {
      debug.UNMASKED_RENDERER_WEBGL = fixed;
      changed = true;
    }
  }
  return changed;
}

/** The bytes of a capture file as the engine should get them: renderers fixed, else the file as is. */
export function captureForEngine(raw: Buffer): Buffer {
  try {
    const obj = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    return fixCaptureRenderers(obj) ? Buffer.from(JSON.stringify(obj), "utf8") : raw;
  } catch {
    return raw; // not JSON — hand it over untouched, as before
  }
}
