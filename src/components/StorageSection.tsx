"use client";

// Settings → Storage. Everything the app keeps on disk, what each part is for, and one click to get
// back what nothing needs: old browser builds (7.9 GB on the machine this was built on, 12 of 13
// builds unused), browser copies outside the cache, and each profile's own caches.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, type ClearMode, type PrefetchProgress, type ProfileSize, type StoragePlan, type TempCopy } from "@/lib/ipc";
import type { LaunchTarget } from "@/lib/launchTarget";
import { useConfirm } from "./Confirm";
import Dialog from "./Dialog";
import { t, tRich } from "@/lib/i18n";

export const fmtSize = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : b > 0 ? `${Math.max(1, Math.round(b / 1e3))} KB` : "0 MB";

const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";
const primary = "shrink-0 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-40";
const h = "text-[13px] font-semibold text-fog";

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={"relative h-5 w-9 shrink-0 rounded-full transition-colors " + (checked ? "bg-accent" : "bg-line-strong")}
    >
      <span
        className={
          "absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform " + (checked ? "translate-x-[18px]" : "translate-x-0.5")
        }
      />
    </button>
  );
}

/** The confirmation for the profiles ticked in the list: their cache (the default, keeps logins) or
 *  all their browser data. One dialog; the button says what goes and how much it frees. */
function ClearProfilesDialog({ picked, onSettle }: { picked: ProfileSize[]; onSettle: (mode: ClearMode | null) => void }) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<ClearMode>("cache");
  const n = picked.length;
  const cacheSize = fmtSize(picked.reduce((a, p) => a + (p.cacheBytes ?? 0), 0));
  const allSize = fmtSize(picked.reduce((a, p) => a + p.bytes, 0));
  const names = picked.map((p) => p.name).join(", ");
  const choice = (value: ClearMode, label: string, body: string) => (
    <label
      className={
        "flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5 transition " +
        (mode === value ? (value === "all" ? "border-danger/60 bg-danger/5" : "border-accent/60 bg-accent/5") : "border-line hover:bg-elevate")
      }
    >
      <input type="radio" name="clear-mode" className="mt-0.5 accent-[#38e0d6]" checked={mode === value} onChange={() => setMode(value)} />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fog/90">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-fog/55">{body}</span>
      </span>
    </label>
  );
  return (
    <Dialog onClose={() => onSettle(null)} labelledBy={titleId} variant="fit" layer="top" className="max-w-md" initialFocus={cancelRef}>
      <div className="space-y-3 px-5 pb-4 pt-5">
        <h2 id={titleId} className="text-base font-semibold">
          {n === 1 ? t("Delete data of “{name}”?", { name: picked[0].name }) : t("Delete data of {n} profiles?", { n })}
        </h2>
        {n > 1 && (
          <p className="truncate text-xs text-fog/50" title={names}>
            {names}
          </p>
        )}
        {choice(
          "cache",
          t("Clear cache · frees {size}", { size: cacheSize }),
          t("Cached pages, scripts and shaders are removed; they rebuild as you browse. Cookies, logins, saved site data, history and extensions stay."),
        )}
        {choice(
          "all",
          t("Delete all browser data · frees {size}", { size: allSize }),
          t("Signs out everywhere: cookies, logins, saved site data, history and extensions are removed. The profile and its settings stay. This cannot be undone."),
        )}
      </div>
      <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
        <button ref={cancelRef} className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={() => onSettle(null)}>
          {t("Cancel")}
        </button>
        <button
          className={
            "rounded-lg px-3.5 py-1.5 text-sm font-semibold " +
            (mode === "all" ? "bg-danger text-surface hover:opacity-90" : "bg-sheen text-[#07080a] hover:opacity-95")
          }
          onClick={() => onSettle(mode)}
        >
          {mode === "all"
            ? n === 1
              ? t("Delete all data of 1 profile ({size})", { size: allSize })
              : t("Delete all data of {n} profiles ({size})", { n, size: allSize })
            : n === 1
              ? t("Clear cache of 1 profile ({size})", { size: cacheSize })
              : t("Clear cache of {n} profiles ({size})", { n, size: cacheSize })}
        </button>
      </div>
    </Dialog>
  );
}

export default function StorageSection({
  autoPrune,
  onAutoPrune,
}: {
  autoPrune: boolean;
  onAutoPrune: (v: boolean) => void;
}) {
  const confirm = useConfirm();
  const [plan, setPlan] = useState<StoragePlan | null>(null);
  const [temp, setTemp] = useState<TempCopy[] | null>(null);
  const [sizes, setSizes] = useState<ProfileSize[] | null>(null);
  const [target, setTarget] = useState<LaunchTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [dl, setDl] = useState<PrefetchProgress | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);

  const load = useCallback(() => {
    void api.storage.plan().then(setPlan).catch(() => setPlan({ keep: [], remove: [], freeBytes: 0, offline: true }));
    void api.storage.temp().then(setTemp).catch(() => setTemp([]));
    void api.storage.profileSizes().then(setSizes).catch(() => setSizes([]));
    void api.launchTarget().then(setTarget).catch(() => setTarget(null));
  }, []);
  useEffect(() => {
    load();
    return api.storage.onPrefetchProgress((p) => setDl(p));
  }, [load]);

  const buildsBytes = plan ? [...plan.keep, ...plan.remove].reduce((s, b) => s + b.sizeBytes, 0) : 0;
  const tempBytes = (temp ?? []).reduce((s, x) => s + x.sizeBytes, 0);
  const profileBytes = (sizes ?? []).reduce((s, p) => s + p.bytes, 0);
  // A running browser has its files open: its row cannot be ticked (the main process refuses it too).
  const selectable = (sizes ?? []).filter((p) => !p.running);
  const picked = selectable.filter((p) => selected.has(p.id));
  const runningNames = (sizes ?? []).filter((p) => p.running).map((p) => p.name);
  const allPicked = selectable.length > 0 && picked.length === selectable.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const total = buildsBytes + tempBytes + profileBytes;

  async function prune() {
    if (!plan?.remove.length) return;
    setBusy("prune");
    setMsg(null);
    try {
      const r = await api.storage.prune();
      setMsg(
        (r.removed === 1
          ? t("Removed 1 build — {size} freed.", { size: fmtSize(r.freedBytes) })
          : t("Removed {n} builds — {size} freed.", { n: r.removed, size: fmtSize(r.freedBytes) })) +
          (r.skipped ? " " + t("{n} in use right now, left for later.", { n: r.skipped }) : ""),
      );
      load();
    } finally {
      setBusy(null);
    }
  }
  async function removeOne(tag: string, version: string, sizeBytes: number) {
    const ok = await confirm({
      title: t("Remove build {version}?", { version }),
      body: t("This frees {size}. It downloads again, and is verified again, on the next launch that needs it.", { size: fmtSize(sizeBytes) }),
      confirmLabel: t("Remove"),
      tone: "danger",
    });
    if (!ok) return;
    setBusy(tag);
    try {
      const removed = await api.cache.remove(tag);
      setMsg(removed ? t("Removed build {version}.", { version }) : t("Build {version} is in use by a running browser — stop it first.", { version }));
      load();
    } finally {
      setBusy(null);
    }
  }
  async function cleanTemp() {
    setBusy("temp");
    try {
      const r = await api.storage.cleanTemp();
      setMsg(
        t("Cleaned up {size}.", { size: fmtSize(r.freedBytes) }) +
          (r.inUse
            ? " " + (r.inUse === 1 ? t("1 copy is in use right now.") : t("{n} copies are in use right now.", { n: r.inUse }))
            : ""),
      );
      load();
    } finally {
      setBusy(null);
    }
  }
  async function clearCache(p: ProfileSize) {
    const ok = await confirm({
      title: t("Clear the cache of “{name}”?", { name: p.name }),
      body: t("Cached pages, scripts and shaders are removed; they rebuild as you browse. Cookies, logins, saved site data, history and extensions stay."),
      confirmLabel: t("Clear cache"),
    });
    if (!ok) return;
    setBusy(`cache:${p.id}`);
    try {
      const r = await api.profiles.clearCache(p.id);
      setMsg(r.ok ? t("Cleared {size} from “{name}”.", { size: fmtSize(r.freedBytes ?? 0), name: p.name }) : r.error || t("Could not clear the cache."));
      load();
    } finally {
      setBusy(null);
    }
  }
  async function clearPicked(mode: ClearMode | null) {
    setAsking(false);
    if (!mode || !picked.length) return;
    setBusy("profiles");
    setMsg(null);
    try {
      const r = await api.storage.clearProfiles(
        picked.map((p) => p.id),
        mode,
      );
      if (r.error) {
        setMsg(r.error);
        return;
      }
      const n = r.cleared.length;
      const size = fmtSize(r.freedBytes);
      let line =
        mode === "all"
          ? n === 1
            ? t("Deleted the browser data of 1 profile — {size} freed.", { size })
            : t("Deleted the browser data of {n} profiles — {size} freed.", { n, size })
          : n === 1
            ? t("Cleared the cache of 1 profile — {size} freed.", { size })
            : t("Cleared the cache of {n} profiles — {size} freed.", { n, size });
      if (r.running.length) line += " " + t("Skipped {names}: the browser is running — stop it first.", { names: r.running.join(", ") });
      if (r.failed.length) line += " " + t("Could not clear {names}.", { names: r.failed.join(", ") });
      setMsg(line);
      setSelected(new Set());
      load();
    } finally {
      setBusy(null);
    }
  }
  async function prefetch() {
    setBusy("prefetch");
    setMsg(null);
    setDl(null);
    try {
      const r = await api.storage.prefetch();
      setMsg(r.ok ? t("Build {version} is ready — the next launch starts straight away.", { version: String(r.version) }) : r.error || t("The download failed."));
      load();
    } finally {
      setBusy(null);
      setDl(null);
    }
  }

  const needsDownload = target?.mode === "managed" && target.downloaded === false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tabular-nums">{plan && temp && sizes ? fmtSize(total) : "…"}</span>
        <span className="text-xs text-fog/45">
          {t("{builds} browser builds · {copies} copies · {profiles} profile data", {
            builds: fmtSize(buildsBytes),
            copies: fmtSize(tempBytes),
            profiles: fmtSize(profileBytes),
          })}
        </span>
      </div>
      {msg && (
        <p role="status" className="rounded-lg bg-accent/10 px-3 py-2 text-xs text-accent">
          {msg}
        </p>
      )}

      {/* Browser builds */}
      <section aria-labelledby="st-builds" className="rounded-xl border border-line bg-ink/30">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div id="st-builds" className={h}>
              {t("Browser builds")}
            </div>
            <div className="mt-0.5 text-xs text-fog/45">
              {plan?.offline
                ? t("Couldn't reach the version list, so nothing is marked unused right now.")
                : plan && plan.remove.length
                  ? plan.remove.length === 1
                    ? t("1 build nothing uses any more.")
                    : t("{n} builds nothing uses any more.", { n: plan.remove.length })
                  : t("Only builds something still uses.")}
            </div>
          </div>
          <button className={primary} onClick={prune} disabled={!plan?.remove.length || busy !== null}>
            {busy === "prune"
              ? t("Removing…")
              : plan?.remove.length
                ? t("Remove unused · frees {size}", { size: fmtSize(plan.freeBytes) })
                : t("Nothing to remove")}
          </button>
        </div>
        {needsDownload && (
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <div className="min-w-0 flex-1 text-xs text-fog/60">
              {t("Build {major} — what profiles on Latest launch — isn't downloaded yet, so the first launch will wait for it.", {
                major: target?.major ?? "",
              })}
              {dl && (
                <span className="mt-1.5 block">
                  <span className="block h-1.5 w-full overflow-hidden rounded-full bg-line">
                    <span className="block h-full rounded-full bg-sheen" style={{ width: `${dl.pct}%` }} />
                  </span>
                  <span className="mt-1 block tabular-nums text-fog/45">
                    {dl.pct}% · {dl.seenMB} / {dl.totalMB} MB
                  </span>
                </span>
              )}
            </div>
            <button className={btn} onClick={prefetch} disabled={busy !== null}>
              {busy === "prefetch" ? t("Downloading…") : t("Download now")}
            </button>
          </div>
        )}
        <ul className="divide-y divide-line">
          {plan === null && <li className="px-4 py-3 text-xs text-fog/45">{t("Loading…")}</li>}
          {plan && plan.keep.length + plan.remove.length === 0 && <li className="px-4 py-3 text-xs text-fog/45">{t("Nothing downloaded yet.")}</li>}
          {plan &&
            [...plan.keep, ...plan.remove].map((b) => (
              <li key={b.tag} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${b.tier === "pro" ? "bg-accent/10 text-accent" : "bg-elevate text-fog/60"}`}>
                  {b.tier === "pro" ? "PRO" : "FREE"}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-fog/80">{b.version}</span>
                {b.reasons?.length ? (
                  <span className="flex flex-wrap gap-1">
                    {b.reasons.map((r) => (
                      <span key={r} className="rounded bg-iris/10 px-1.5 py-0.5 text-[10px] text-iris">
                        {r}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="rounded bg-elevate px-1.5 py-0.5 text-[10px] text-fog/45">{t("unused")}</span>
                )}
                <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-fog/45">{fmtSize(b.sizeBytes)}</span>
                <button
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-danger/80 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                  onClick={() => removeOne(b.tag, b.version, b.sizeBytes)}
                  disabled={busy !== null}
                  aria-label={t("Remove build {version}", { version: b.version })}
                >
                  {busy === b.tag ? t("Removing…") : t("Remove")}
                </button>
              </li>
            ))}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <div className="min-w-0 flex-1 text-xs text-fog/60">
            {tRich(
              "<b>Remove old builds automatically</b> — after a newer build downloads. The build Latest uses, pinned builds and running ones always stay.",
              { b: (s) => <span className="font-medium text-fog/80">{s}</span> },
            )}
          </div>
          <Toggle label={t("Remove old builds automatically")} checked={autoPrune} onChange={onAutoPrune} />
        </div>
      </section>

      {/* Copies outside the cache */}
      <section aria-labelledby="st-temp" className="rounded-xl border border-line bg-ink/30">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div id="st-temp" className={h}>
              {t("Browser copies in the temp folder")}
            </div>
            <div className="mt-0.5 text-xs text-fog/45">
              {temp === null
                ? t("Loading…")
                : temp.length === 0
                  ? t("None.")
                  : temp.length === 1
                    ? t("1 copy, {size} — launch copies that work around a Windows first-launch problem, and leftovers from the SDK. Made again when needed.", { size: fmtSize(tempBytes) })
                    : t("{n} copies, {size} — launch copies that work around a Windows first-launch problem, and leftovers from the SDK. Made again when needed.", {
                        n: temp.length,
                        size: fmtSize(tempBytes),
                      })}
            </div>
          </div>
          <button className={btn} onClick={cleanTemp} disabled={!temp?.length || busy !== null}>
            {busy === "temp" ? t("Cleaning…") : t("Clean up")}
          </button>
        </div>
      </section>

      {/* Profile data */}
      <section aria-labelledby="st-profiles" className="rounded-xl border border-line bg-ink/30">
        <div className="border-b border-line px-4 py-3">
          <div id="st-profiles" className={h}>
            {t("Profile data")}
          </div>
          <div className="mt-0.5 text-xs text-fog/45">
            {t("Each profile's cookies, logins and cache. Clearing the cache keeps you signed in.")}
          </div>
        </div>
        {!!sizes?.length && (
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
            <input
              type="checkbox"
              className="accent-[#38e0d6]"
              checked={allPicked}
              ref={(el) => {
                if (el) el.indeterminate = picked.length > 0 && !allPicked;
              }}
              onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((p) => p.id)) : new Set())}
              disabled={!selectable.length || busy !== null}
              aria-label={t("Select all profiles")}
            />
            <span className="min-w-0 flex-1 text-xs text-fog/55">
              {picked.length ? t("{n} selected", { n: picked.length }) : t("Tick profiles to delete their data together.")}
              {runningNames.length > 0 && (
                <span className="block text-fog/40">{t("Running, so not selectable: {names}.", { names: runningNames.join(", ") })}</span>
              )}
            </span>
            <button className={btn} onClick={() => setAsking(true)} disabled={!picked.length || busy !== null}>
              {busy === "profiles"
                ? t("Deleting…")
                : picked.length === 1
                  ? t("Delete data of 1 profile")
                  : t("Delete data of {n} profiles", { n: picked.length })}
            </button>
          </div>
        )}
        <ul className="divide-y divide-line">
          {sizes === null && <li className="px-4 py-3 text-xs text-fog/45">{t("Loading…")}</li>}
          {sizes?.length === 0 && <li className="px-4 py-3 text-xs text-fog/45">{t("No profiles yet.")}</li>}
          {[...(sizes ?? [])]
            .sort((a, b) => b.bytes - a.bytes)
            .map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <input
                  type="checkbox"
                  className="accent-[#38e0d6]"
                  checked={!p.running && selected.has(p.id)}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                  disabled={p.running || busy !== null}
                  title={p.running ? t("Stop its browser first — it has its data open.") : undefined}
                  aria-label={t("Select {name}", { name: p.name })}
                />
                <span className="min-w-0 flex-1 truncate text-xs text-fog/80">{p.name}</span>
                <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-fog/45">{fmtSize(p.bytes)}</span>
                <button
                  className="shrink-0 rounded-md px-2 py-1 text-[11px] text-fog/70 hover:bg-elevate disabled:opacity-40"
                  onClick={() => clearCache(p)}
                  disabled={p.running || p.bytes === 0 || busy !== null}
                  title={p.running ? t("Stop its browser first — it has the cache open.") : undefined}
                  aria-label={t("Clear cache of {name}", { name: p.name })}
                >
                  {busy === `cache:${p.id}` ? t("Clearing…") : t("Clear cache")}
                </button>
              </li>
            ))}
        </ul>
      </section>
      {asking && picked.length > 0 && <ClearProfilesDialog picked={picked} onSettle={clearPicked} />}
    </div>
  );
}
