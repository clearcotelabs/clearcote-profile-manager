// The GPU model picker's logic, kept apart from the React that draws it.
//
// The picker is a VIEW over two stored fields, `gpuVendor` and `gpuRenderer` — no new profile key,
// so every profile saved before it exists reads back unchanged: strings that match a table entry
// show as that model, anything else shows as Custom with the strings intact, and nothing set shows
// as the persona default. Which form a model writes (Windows or Linux) follows the PROFILE's
// persona platform, because the renderer string names the graphics backend the persona claims.
//
// PURE: no React, no `node:` imports, no Electron. The editor and the tests import it.

import { findModel, modelsForVendor, randomModel, stringsFor, GPU_MODELS, type GpuModel, type GpuVendor } from "./gpuModels";

export type HostGpuVendor = GpuVendor | "unknown";

/** What the editor keeps about this machine's GPU (electron/hostgpu.ts, over IPC). */
export interface HostGpuInfo {
  vendor: HostGpuVendor;
  name: string;
  deviceId: number | null;
}

/** The profile keys the picker reads and writes. Loose on purpose: the editor's in-progress draft. */
export type GpuFields = { gpuVendor?: unknown; gpuRenderer?: unknown; platform?: unknown };

/** Vendor labels as the vendors spell them. */
export const VENDOR_LABEL: Record<GpuVendor, string> = { nvidia: "NVIDIA", intel: "Intel", amd: "AMD" };

export const PICKER_DEFAULT = "";
export const PICKER_CUSTOM = "custom";

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Which string form a persona platform claims. Only a Linux persona takes the OpenGL form; macOS
 *  has no form in the table, so it falls back to the Windows one like the rest. */
export function stringPlatformFor(platform: unknown): "windows" | "linux" {
  return platform === "linux" ? "linux" : "windows";
}

/** The picker is for desktop personas. An Android persona hides it: the engine has its own phone
 *  device table, and whatever is stored stays stored. */
export function showGpuPicker(p: GpuFields): boolean {
  return p.platform !== "android";
}

/** The select option value for a model — stable across data refreshes as long as the id is. */
export function modelOptionValue(m: GpuModel): string {
  return `${m.vendor}:0x${m.deviceId.toString(16)}`;
}

export function modelFromOptionValue(v: string): GpuModel | null {
  return GPU_MODELS.find((m) => modelOptionValue(m) === v) ?? null;
}

/** The table model the stored pair denotes (in either platform's form), or null. */
export function selectedModel(p: GpuFields): GpuModel | null {
  return findModel(str(p.gpuVendor), str(p.gpuRenderer));
}

/**
 * What the select should show for the stored pair: the default when both are empty, the model when
 * they match a table entry, Custom otherwise. `forceCustom` is the editor's "the user chose
 * Custom… over a model and has not moved since" flag — strings that still match a model would
 * otherwise snap the select back the moment Custom… was chosen.
 */
export function pickerValue(p: GpuFields, forceCustom = false): string {
  if (forceCustom) return PICKER_CUSTOM;
  const v = str(p.gpuVendor).trim();
  const r = str(p.gpuRenderer).trim();
  if (!v && !r) return PICKER_DEFAULT;
  const m = findModel(v, r);
  return m ? modelOptionValue(m) : PICKER_CUSTOM;
}

export function isCustom(p: GpuFields, forceCustom = false): boolean {
  return pickerValue(p, forceCustom) === PICKER_CUSTOM;
}

export interface PickerGroup {
  vendor: GpuVendor;
  /** "NVIDIA — this machine's GPU maker" for the host's group, the bare name for the rest. */
  label: string;
  host: boolean;
  models: GpuModel[];
}

/**
 * The option groups, one per vendor, with this machine's vendor first when it is known. The other
 * vendors stay on offer — a cross-vendor claim is a choice the coherence rule warns about, not one
 * the picker forbids — but the host's models are what most people should pick, so they come first.
 */
export function pickerGroups(host: HostGpuVendor): PickerGroup[] {
  const vendors: GpuVendor[] = ["nvidia", "intel", "amd"];
  const ordered = host === "unknown" ? vendors : [host, ...vendors.filter((v) => v !== host)];
  return ordered
    .map((vendor) => ({
      vendor,
      host: vendor === host,
      label: vendor === host ? `${VENDOR_LABEL[vendor]} — this machine's GPU maker` : VENDOR_LABEL[vendor],
      models: modelsForVendor(vendor),
    }))
    .filter((g) => g.models.length > 0);
}

/** The profile with a model's strings written for its persona platform. */
export function applyModel<P extends GpuFields>(p: P, m: GpuModel): P {
  return { ...p, ...stringsFor(m, stringPlatformFor(p.platform)) };
}

/** The profile with both strings cleared — the persona default. */
export function clearModel<P extends GpuFields>(p: P): P {
  const out = { ...p };
  delete (out as GpuFields).gpuVendor;
  delete (out as GpuFields).gpuRenderer;
  return out;
}

/**
 * The profile after one select change. The default clears both strings; a model writes both;
 * Custom keeps whatever is there (so the strings of the model just shown are the starting point
 * for editing). Returns the profile and whether the editor should hold Custom open.
 */
export function selectGpuOption<P extends GpuFields>(p: P, value: string): { profile: P; forceCustom: boolean } {
  if (value === PICKER_DEFAULT) return { profile: clearModel(p), forceCustom: false };
  if (value === PICKER_CUSTOM) return { profile: p, forceCustom: true };
  const m = modelFromOptionValue(value);
  if (!m) return { profile: p, forceCustom: false };
  return { profile: applyModel(p, m), forceCustom: false };
}

/**
 * A random model of this machine's vendor (any vendor when unknown), never the one currently
 * selected, written in the persona platform's form.
 */
export function randomGpu<P extends GpuFields>(p: P, host: HostGpuVendor, rnd?: () => number): P {
  return applyModel(p, randomModel(host, selectedModel(p), rnd));
}

/**
 * The profile with its platform changed. When a table model is selected, its strings are rewritten
 * in the new platform's form, so a Windows profile moved to Linux claims the OpenGL renderer rather
 * than a Direct3D11 one no Linux persona prints. Custom strings are the user's own and stay; an
 * Android persona keeps whatever is stored, since the picker is hidden there.
 */
export function withPlatform<P extends GpuFields>(p: P, platform: unknown): P {
  const next = { ...p, platform } as P;
  if (platform === "android") return next;
  const m = selectedModel(p);
  return m ? applyModel(next, m) : next;
}

/**
 * The vendor a stored pair claims: a table model's vendor, or the maker a custom string names.
 * Null when neither says. Used by the coherence rule, which compares it with the host's.
 */
export function claimedVendor(p: GpuFields): GpuVendor | null {
  const m = selectedModel(p);
  if (m) return m.vendor;
  const text = `${str(p.gpuVendor)} ${str(p.gpuRenderer)}`;
  if (/nvidia|geforce/i.test(text)) return "nvidia";
  if (/intel|iris|uhd graphics/i.test(text)) return "intel";
  if (/\bamd\b|radeon/i.test(text)) return "amd";
  return null;
}
