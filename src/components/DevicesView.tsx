"use client";

// Device profiles: the clearcote-profiles library, ranked for this computer (src/lib/deviceMatch.ts). The best
// matches come first with their reasons in words; one click makes new profiles, each on its own unused device, or
// gives the selected profiles one each. A device is a real Windows Chrome capture (GPU, screen, threads, fonts):
// on a computer with another GPU maker, sites can tell, so those are hidden unless asked for.

import { useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { api, type LibraryProfile } from "@/lib/ipc";
import { rankDevices, type DeviceMatch, type GpuMaker, type HostFacts, type HostOsName, type Reason } from "@/lib/deviceMatch";
import { displayName } from "@/lib/profileList";
import type { Profile } from "@/types/profile";

const ghost = "rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const primary = "shrink-0 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-40";
const field =
  "rounded-lg border border-line bg-ink/70 px-3 py-1.5 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60";
const BEST = 6;
const MAX_CREATE = 20;

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 …)" -> "NVIDIA GeForce RTX 3060". */
export function gpuLabel(lib: LibraryProfile): string {
  const r = lib.renderer || "";
  const m = /^ANGLE \([^,]+,\s*(.+?)(?:\s*\(0x[0-9a-f]+\))?\s+(?:Direct3D|OpenGL|Vulkan)/i.exec(r);
  return (m ? m[1] : r || lib.gpuFamily || lib.name).replace(/\((?:R|TM)\)/g, "").replace(/\s+/g, " ").trim();
}

/** The file's page on GitHub (an allowed link), where it can be read or downloaded. */
function fileLink(lib: LibraryProfile): string {
  return lib.downloadUrl.replace(
    /^https:\/\/raw\.githubusercontent\.com\/clearcotelabs\/clearcote-profiles\/main\//,
    "https://github.com/clearcotelabs/clearcote-profiles/blob/main/",
  );
}

const say = (r: Reason) => t(r.text, r.params);
const OS_LABEL: Record<HostOsName, string> = { windows: "Windows", linux: "Linux", macos: "macOS" };
const MAKER_LABEL: Record<GpuMaker, string> = { nvidia: "NVIDIA", intel: "Intel", amd: "AMD" };

function Score({ m }: { m: DeviceMatch }) {
  const tone = !m.fits ? "border-danger/40 text-danger" : m.score >= 80 ? "border-accent/50 text-accent" : "border-line text-fog/70";
  return (
    <span className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${tone}`}
      title={t("Fit with this computer, out of 100")} data-device-score={m.score}>
      {m.fits ? m.score : "–"}
    </span>
  );
}

function Specs({ lib }: { lib: LibraryProfile }) {
  const parts = [
    lib.screen?.replace("x", "×"),
    lib.cores ? t("{n} threads", { n: lib.cores }) : null,
    lib.memory ? t("{n} GB", { n: lib.memory }) : null,
  ].filter(Boolean);
  return <span className="text-[12px] text-fog/50">{parts.join(" · ")}</span>;
}

export default function DevicesView({
  profiles,
  selected,
  hostOs,
  onCreate,
  onAssign,
  onUseOn,
}: {
  profiles: Profile[];
  /** Ids of the profiles selected on the profiles page. */
  selected: Set<string>;
  hostOs?: HostOsName;
  /** Make one new profile per device. Resolves to how many were made. */
  onCreate: (libs: LibraryProfile[], opts: { prefix: string; group: string }) => Promise<number>;
  /** Give each selected profile its own best unused device. */
  onAssign: (library: LibraryProfile[], host: HostFacts, opts: { replace: boolean }) => Promise<void>;
  /** Put this one device on one profile. */
  onUseOn: (lib: LibraryProfile, profile: Profile) => Promise<void>;
}) {
  const [library, setLibrary] = useState<LibraryProfile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gpu, setGpu] = useState<{ vendor: GpuMaker | "unknown"; name: string } | null>(null);
  const [maker, setMaker] = useState<GpuMaker | "all">("all");
  const [onlyFit, setOnlyFit] = useState(true);
  const [hideUsed, setHideUsed] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [count, setCount] = useState(5);
  const [prefix, setPrefix] = useState("");
  const [group, setGroup] = useState("");
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.fp.library().then((r) => (r.ok ? setLibrary(r.profiles || []) : setErr(r.error || t("Failed to load library."))));
    (api.hostGpu?.() ?? Promise.resolve(null))
      .then((g) => setGpu(g ? { vendor: g.vendor, name: g.name } : { vendor: "unknown", name: "" }))
      .catch(() => setGpu({ vendor: "unknown", name: "" }));
  }, []);

  const host: HostFacts = useMemo(
    () => ({
      vendor: gpu?.vendor ?? "unknown",
      gpuName: gpu?.name || undefined,
      threads: typeof navigator !== "undefined" ? navigator.hardwareConcurrency || undefined : undefined,
      os: hostOs,
    }),
    [gpu, hostOs],
  );
  const ranked = useMemo(() => (library && gpu ? rankDevices(library, host, profiles) : []), [library, gpu, host, profiles]);
  const names = useMemo(() => new Map(profiles.map((p) => [p.id, displayName(p)])), [profiles]);
  const best = ranked.filter((m) => m.fits).slice(0, BEST);
  const unusedFitting = ranked.filter((m) => m.fits && !m.usedBy.length).length;
  const chosen = profiles.filter((p) => selected.has(p.id));

  const shown = ranked.filter((m) => {
    if (onlyFit && !m.fits) return false;
    if (hideUsed && m.usedBy.length) return false;
    if (maker !== "all" && !(m.lib.gpuVendor || "").toLowerCase().includes(maker)) return false;
    const s = q.trim().toLowerCase();
    return !s || `${m.lib.renderer ?? ""} ${m.lib.screen ?? ""} ${m.lib.name}`.toLowerCase().includes(s);
  });

  async function create(libs: LibraryProfile[]) {
    setBusy(true);
    try {
      await onCreate(libs, { prefix: prefix.trim(), group: group.trim() });
    } finally {
      setBusy(false);
    }
  }

  const hostLine = gpu
    ? [
        gpu.name || (gpu.vendor !== "unknown" ? MAKER_LABEL[gpu.vendor] : t("GPU unknown")),
        host.threads ? t("{n} threads", { n: host.threads }) : null,
        hostOs ? OS_LABEL[hostOs] : null,
      ].filter(Boolean).join(" · ")
    : t("Checking…");

  const card = (m: DeviceMatch, wide = false) => {
    const isOpen = open === m.lib.name;
    return (
      <div key={m.lib.name} className={`rounded-xl border border-line bg-surface/70 ${wide ? "" : "p-3"}`} data-device={m.lib.name}>
        <button
          type="button"
          className={`flex w-full items-start gap-3 text-left ${wide ? "px-4 py-3 hover:bg-elevate/50" : ""}`}
          onClick={() => setOpen(isOpen ? null : m.lib.name)}
          aria-expanded={isOpen}
        >
          <Score m={m} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{gpuLabel(m.lib)}</span>
            <Specs lib={m.lib} />
            {m.usedBy.length > 0 && (
              <span className="ml-2 rounded border border-line px-1.5 text-[10px] text-fog/50" data-device-used={m.usedBy.length}>
                {m.usedBy.length === 1 ? t("In use by 1 profile") : t("In use by {n} profiles", { n: m.usedBy.length })}
              </span>
            )}
            {!wide && (
              <span className="mt-1.5 block space-y-0.5">
                {m.reasons.filter((r) => r.good).slice(0, 3).map((r) => (
                  <span key={r.text} className="block truncate text-[11px] text-fog/45">✓ {say(r)}</span>
                ))}
              </span>
            )}
          </span>
        </button>
        {isOpen && (
          <div className={`${wide ? "border-t border-line px-4 py-3" : "mt-3 border-t border-line pt-3"} space-y-2`} data-device-detail="1">
            <ul className="space-y-0.5">
              {m.reasons.map((r) => (
                <li key={r.text} className={`text-[12px] ${r.good ? "text-fog/60" : "text-warn"}`}>
                  {r.good ? "✓" : "!"} {say(r)}
                </li>
              ))}
            </ul>
            <p className="break-all font-mono text-[10px] text-fog/35">{m.lib.renderer}</p>
            {m.usedBy.length > 0 && (
              <p className="text-[11px] text-fog/50">
                {t("Used by: {names}", { names: m.usedBy.map((id) => names.get(id) || id).join(", ") })}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5 pt-1">
              <button type="button" className={ghost} disabled={busy} onClick={() => void create([m.lib])} data-device-create-one="1">
                {t("Create a profile with it")}
              </button>
              {chosen.length === 1 && (
                <button type="button" className={ghost} disabled={busy} onClick={() => void onUseOn(m.lib, chosen[0])} data-device-use-on="1">
                  {t("Use on “{name}”", { name: displayName(chosen[0]) })}
                </button>
              )}
              <button type="button" className={ghost} onClick={() => void api.openExternal(fileLink(m.lib))}>
                {t("View the .json")}
              </button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mt-4 space-y-6" data-devices-view="1">
      <p className="max-w-3xl text-sm text-fog/55">
        {t("Real devices captured from Windows Chrome: GPU, screen, threads, memory and fonts. A profile on one of them reports that device's values. The best fits for this computer come first; one device per profile keeps your profiles apart.")}
      </p>
      <p className="text-[12px] text-fog/50" data-devices-host="1">
        {t("This computer: {facts}", { facts: hostLine })}
        {gpu?.vendor === "unknown" && <span className="ml-2 text-warn">{t("The GPU maker is unknown, so every device is shown.")}</span>}
      </p>

      {err && <div className="rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">{err}</div>}
      {!library && !err && <p className="text-sm text-fog/50">{t("Loading the library…")}</p>}

      {chosen.length > 0 && library && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-4 py-3" data-devices-assign="1">
          <span className="text-sm">
            {chosen.length === 1 ? t("1 profile selected") : t("{n} profiles selected", { n: chosen.length })}
          </span>
          <label className="flex items-center gap-1.5 text-[12px] text-fog/60">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {t("Also replace devices they already have")}
          </label>
          <span className="flex-1" />
          <button type="button" className={primary} disabled={busy} data-devices-assign-run="1"
            onClick={async () => {
              setBusy(true);
              try {
                await onAssign(library, host, { replace });
              } finally {
                setBusy(false);
              }
            }}>
            {t("Give each its best device")}
          </button>
        </div>
      )}

      {library && (
        <section>
          <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
            <h3 className="text-base font-semibold">{t("Best for this computer")}</h3>
            <div className="flex flex-wrap items-center gap-2" data-devices-create="1">
              <label className="text-[12px] text-fog/55" htmlFor="devices-count">{t("New profiles")}</label>
              <input id="devices-count" type="number" min={1} max={MAX_CREATE} value={count} className={field + " w-16"}
                onChange={(e) => setCount(Math.max(1, Math.min(MAX_CREATE, Number(e.target.value) || 1)))} />
              <input aria-label={t("Name")} placeholder={t("Name, e.g. Shop")} value={prefix} className={field + " w-36"}
                onChange={(e) => setPrefix(e.target.value)} />
              <input aria-label={t("Group")} placeholder={t("Group (optional)")} value={group} className={field + " w-36"}
                onChange={(e) => setGroup(e.target.value)} />
              <button type="button" className={primary} disabled={busy || unusedFitting === 0} data-devices-create-run="1"
                onClick={() => void create(ranked.filter((m) => m.fits && !m.usedBy.length).slice(0, count).map((m) => m.lib))}>
                {t("Create {n} on different devices", { n: Math.min(count, unusedFitting) })}
              </button>
            </div>
          </div>
          {count > unusedFitting && (
            <p className="mb-2 text-[12px] text-warn" data-devices-short="1">
              {t("Only {n} unused devices fit this computer, so it makes {n}.", { n: unusedFitting })}
            </p>
          )}
          {best.length ? (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]" data-devices-best="1">
              {best.map((m) => card(m))}
            </div>
          ) : (
            <p className="text-sm text-fog/50">{t("No device in the library fits this computer.")}</p>
          )}
        </section>
      )}

      {library && (
        <section>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="mr-2 text-base font-semibold">{t("All devices")}</h3>
            {(["all", "nvidia", "intel", "amd"] as const).map((v) => (
              <button key={v} type="button" onClick={() => setMaker(v)} aria-pressed={maker === v}
                className={`rounded-md px-2 py-0.5 text-[11px] ${maker === v ? "bg-elevate text-fog" : "text-fog/55 hover:text-fog"}`}>
                {v === "all" ? t("All") : MAKER_LABEL[v]}
              </button>
            ))}
            <input aria-label={t("Search devices")} placeholder={t("Search a GPU or screen…")} value={q}
              className={field + " ml-auto w-56"} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="mb-3 flex flex-wrap gap-4 text-[12px] text-fog/60">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={onlyFit} onChange={(e) => setOnlyFit(e.target.checked)} data-devices-only-fit="1" />
              {t("Only devices that fit this computer")}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={hideUsed} onChange={(e) => setHideUsed(e.target.checked)} />
              {t("Hide devices in use")}
            </label>
            <span className="text-fog/40">{t("{shown} of {total}", { shown: shown.length, total: ranked.length })}</span>
          </div>
          <div className="space-y-2" data-devices-all="1">{shown.map((m) => card(m, true))}</div>
          <p className="mt-4 text-[11px] text-fog/40">
            {t("From the clearcote-profiles library, derived from chrome-fingerprints by Vinyzu (GPL-3.0).")}
          </p>
        </section>
      )}
    </div>
  );
}
