"use client";

// Every proxy your profiles use, once each: where it last exited, which profiles share it, and the
// two things people do with a proxy list — check them all, and swap a dead server for a new one
// in every profile that used it. Built from the profiles themselves, so there is nothing new to
// keep in step: a proxy exists here as long as a profile uses it.

import { useState } from "react";
import { t } from "@/lib/i18n";
import { displayName, relativeTime } from "@/lib/profileList";
import type { ProxyRow } from "@/lib/workspace";

const ghost = "rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const th = "px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40";

export default function ProxiesView({
  rows,
  profileCount,
  checking,
  onCheck,
  onCheckAll,
  onShowProfiles,
  onReplace,
  onFromList,
}: {
  rows: ProxyRow[];
  profileCount: number;
  /** Keys being checked right now. */
  checking: ReadonlySet<string>;
  onCheck: (row: ProxyRow) => void;
  onCheckAll: () => void;
  onShowProfiles: (row: ProxyRow) => void;
  onReplace: (row: ProxyRow) => void;
  onFromList: () => void;
}) {
  const [q, setQ] = useState("");
  const shown = rows.filter((r) => {
    const s = q.trim().toLowerCase();
    if (!s) return true;
    const g = r.lastGeo;
    return `${r.key} ${g?.city ?? ""} ${g?.country ?? ""} ${g?.countryCode ?? ""} ${r.profiles.map(displayName).join(" ")}`.toLowerCase().includes(s);
  });
  const without = profileCount - rows.reduce((n, r) => n + r.profiles.length, 0);

  return (
    <div className="mt-5" data-proxies-page>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-full max-w-xs rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60"
          placeholder={t("Search host, country or profile…")}
          aria-label={t("Search proxies")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-xs text-fog/40">
          {rows.length === 1 ? t("1 proxy") : t("{n} proxies", { n: rows.length })}
          {without > 0 ? ` · ${without === 1 ? t("1 profile without one") : t("{n} profiles without one", { n: without })}` : ""}
        </span>
        <span className="flex-1" />
        <button className={ghost} onClick={onCheckAll} disabled={!rows.length || checking.size > 0}>
          {checking.size ? t("Checking…") : t("Check all")}
        </button>
        <button className={ghost} onClick={onFromList}>
          {t("New profiles from a proxy list…")}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="mt-10 text-center">
          <p className="text-base font-semibold">{t("No profile uses a proxy yet")}</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-fog/50">
            {t("Paste a list and get one profile per proxy, or add a proxy in a profile's Network settings.")}
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-xl border border-line bg-surface/70">
          <table className="w-full min-w-[640px] border-collapse">
            <thead className="border-b border-line">
              <tr>
                <th className={th}>{t("Proxy")}</th>
                <th className={th}>{t("Last exit")}</th>
                <th className={th}>{t("Used by")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const g = r.lastGeo;
                const busy = checking.has(r.key);
                const names = r.profiles.map(displayName);
                return (
                  <tr key={r.key} className="border-b border-line last:border-0" data-proxy-row={r.key}>
                    <td className="px-3 py-2.5">
                      <div className="font-mono text-[12px]">
                        {r.host}:{r.port}
                      </div>
                      <div className="text-[11px] text-fog/40">
                        {r.scheme}
                        {r.auth ? ` · ${t("with login")}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[12px]">
                      {g ? (
                        <>
                          <div className="text-accent">{[g.city, g.countryCode || g.country].filter(Boolean).join(", ") || g.ip}</div>
                          <div className="text-[11px] text-fog/40">
                            {g.ip ? `${g.ip} · ` : ""}
                            {relativeTime(g.at)}
                          </div>
                        </>
                      ) : (
                        <span className="text-fog/35">{t("Not checked yet.")}</span>
                      )}
                    </td>
                    <td className="max-w-[16rem] px-3 py-2.5 text-[12px]">
                      <button className="block max-w-full truncate text-left hover:underline" onClick={() => onShowProfiles(r)} title={names.join(", ")}>
                        {r.profiles.length === 1 ? names[0] : t("{n} profiles", { n: r.profiles.length })}
                      </button>
                      {r.profiles.length > 1 && <div className="truncate text-[11px] text-fog/40">{names.slice(0, 3).join(", ")}{names.length > 3 ? "…" : ""}</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right">
                      <div className="inline-flex gap-1.5">
                        <button className={ghost} onClick={() => onCheck(r)} disabled={busy} aria-label={t("Check where {proxy} exits", { proxy: r.key })}>
                          {busy ? t("Checking…") : t("Check")}
                        </button>
                        <button className={ghost} onClick={() => onReplace(r)} aria-label={t("Replace {proxy} in its profiles", { proxy: r.key })}>
                          {t("Replace…")}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-fog/40">
        {t("A check goes through the first profile that uses the proxy and keeps the answer on that profile. Profiles that share a server but log in differently are one row.")}
      </p>
    </div>
  );
}
