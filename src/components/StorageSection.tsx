"use client";

// Settings → Storage. Everything the app keeps on disk, what each part is for, and one click to get
// back what nothing needs: old browser builds (7.9 GB on the machine this was built on, 12 of 13
// builds unused), browser copies outside the cache, and each profile's own caches.

import { useCallback, useEffect, useState } from "react";
import { api, type PrefetchProgress, type ProfileSize, type StoragePlan, type TempCopy } from "@/lib/ipc";
import type { LaunchTarget } from "@/lib/launchTarget";
import { useConfirm } from "./Confirm";
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
        <ul className="divide-y divide-line">
          {sizes === null && <li className="px-4 py-3 text-xs text-fog/45">{t("Loading…")}</li>}
          {sizes?.length === 0 && <li className="px-4 py-3 text-xs text-fog/45">{t("No profiles yet.")}</li>}
          {[...(sizes ?? [])]
            .sort((a, b) => b.bytes - a.bytes)
            .map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
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
    </div>
  );
}
