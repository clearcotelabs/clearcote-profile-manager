"use client";

// One profile's details beside the list: what it is, where it exits, what is wrong with it and the
// one action that fixes each thing. Read-mostly — every setting still lives in the editor, which
// "Edit" (or a Fix →) opens on the right field.

import { useEffect, useRef } from "react";
import { t } from "@/lib/i18n";
import { actionLabel } from "@/lib/launchError";
import { displayName, geoLabel, proxySummary, relativeTime, versionInfo } from "@/lib/profileList";
import { personaLabel } from "@/lib/workspace";
import { formatBytes, formatEur } from "../../electron/cloudtext";
import Menu from "./Menu";
import { profileMenuItems, type CardProps } from "./ProfileCard";

const ghost = "rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const box = "rounded-xl border border-line bg-ink/40 p-3";
const label = "text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40";

function Fact({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt className="text-fog/40">{k}</dt>
      <dd className={"min-w-0 truncate " + (mono ? "font-mono text-[11px]" : "")}>{v}</dd>
    </>
  );
}

export default function ProfileInspector(
  props: CardProps & {
    attention: { text: string; field?: string }[];
    onClose: () => void;
  },
) {
  const p = props.profile;
  const name = displayName(p);
  const geo = geoLabel(p);
  const proxy = proxySummary(p.proxy);
  const version = versionInfo(p.browserVersion);
  const closeRef = useRef<HTMLButtonElement>(null);
  const notice = props.notice;
  const coherence = props.attention.filter((a) => a.field);

  // Focus moves in when it opens for another profile, so keyboard users land in it.
  useEffect(() => closeRef.current?.focus({ preventScroll: true }), [p.id]);

  const when = (iso?: string) => (iso ? relativeTime(iso) ?? "" : t("never"));

  return (
    <aside
      aria-label={t("Details of {name}", { name })}
      data-inspector={p.id}
      className="fixed inset-y-0 right-0 z-[35] flex w-[23rem] max-w-[100vw] flex-col border-l border-line-strong bg-surface shadow-[-24px_0_60px_-30px_rgba(0,0,0,0.6)] animate-fade-up"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold" title={name}>
            {name}
          </h2>
          <div className="mt-0.5 truncate text-[11px] text-fog/45">
            {props.cloud
              ? t("Running on Clearcote's servers")
              : props.running
                ? t("Open on this computer")
                : t("Last launched {when}", { when: when(p.lastLaunchedAt) })}
            {p.group ? ` · ${p.group}` : ""}
          </div>
        </div>
        <Menu label={t("More actions for {name}", { name })} items={profileMenuItems({ ...props, onDetails: undefined })} />
        <button ref={closeRef} className="rounded-md px-1.5 py-1 text-fog/45 hover:bg-elevate hover:text-fog" onClick={props.onClose} aria-label={t("Close details")}>
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 text-[13px]">
        <div className="flex flex-wrap gap-1.5">
          {props.cloud ? (
            <>
              <button className="flex-1 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] disabled:opacity-50" onClick={props.onCloudOpen} disabled={props.cloud.status !== "running"}>
                {t("Open window")}
              </button>
              <button className={ghost} onClick={props.onCloudStop} disabled={props.cloud.status === "stopping"}>
                {t("Stop in the cloud")}
              </button>
            </>
          ) : props.running ? (
            <button className={ghost + " flex-1"} onClick={props.onStop}>
              {t("Close its browser")}
            </button>
          ) : (
            <>
              <button
                className="flex-1 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-50"
                onClick={props.onLaunch}
                disabled={props.launching || props.cloudStarting}
              >
                {props.launching ? t("Launching…") : props.cloudStarting ? t("Starting in the cloud…") : t("Launch")}
              </button>
              <button className={ghost} onClick={props.onCloudStart} disabled={props.launching || props.cloudStarting}>
                {t("Run in the cloud")}
              </button>
            </>
          )}
          <button className={ghost} onClick={() => props.onEdit()}>
            {t("Edit settings")}
          </button>
        </div>

        {notice && (
          <div className={"rounded-xl border p-3 text-xs " + (notice.tone === "error" ? "border-danger/30 bg-danger/5" : "border-warn/30 bg-warn/5")}>
            <p className={"font-medium " + (notice.tone === "error" ? "text-danger" : "text-warn")}>{t(notice.title)}</p>
            {notice.lines.map((l, i) => (
              <p key={i} className="mt-1 break-words text-fog/60">
                {t(l)}
              </p>
            ))}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {notice.action && (
                <button className={ghost} onClick={() => props.onNoticeAction(notice.action!)}>
                  {t(actionLabel(notice.action))}
                </button>
              )}
              <button className="rounded-md px-2 py-1 text-[11px] text-fog/45 hover:bg-elevate" onClick={props.onDismissNotice}>
                {t("Dismiss")}
              </button>
            </div>
          </div>
        )}

        {coherence.length > 0 && (
          <div className="rounded-xl border border-warn/30 bg-warn/5 p-3" data-inspector-issues>
            <div className={label + " text-warn"}>{coherence.length === 1 ? t("1 thing contradicts the rest") : t("{n} things contradict the rest", { n: coherence.length })}</div>
            <ul className="mt-2 space-y-2">
              {coherence.map((a, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <span className="min-w-0 flex-1 text-fog/70">{a.text}</span>
                  <button className="shrink-0 rounded-md border border-line-strong px-2 py-0.5 text-[11px] font-medium hover:bg-elevate" onClick={() => props.onEdit(a.field)}>
                    {t("Fix →")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={box}>
          <div className={label}>{t("Where its traffic leaves")}</div>
          <div className="mt-1.5 font-medium">
            {props.cloud ? props.cloud.exit ?? t("cloud") : geo ? geo.text : proxy ? t("Not checked yet.") : t("This computer's own connection")}
          </div>
          {props.cloud ? (
            <div className="mt-0.5 text-[11px] text-fog/45">
              {formatBytes(props.cloud.bytes)} · {formatEur(props.cloud.costEur)}
            </div>
          ) : (
            (geo || proxy) && (
              <div className="mt-0.5 truncate text-[11px] text-fog/45" title={geo ? t(geo.title) : proxy ?? undefined}>
                {proxy}
                {p.lastGeo?.ip && geo ? ` · ${p.lastGeo.ip}` : ""}
                {p.lastGeo?.at && geo ? ` · ${relativeTime(p.lastGeo.at)}` : ""}
              </div>
            )
          )}
          {proxy && !props.cloud && (
            <button className={ghost + " mt-2"} onClick={props.onCheckGeo} data-inspector-check>
              {t("Check where it exits")}
            </button>
          )}
        </div>

        <div className={box}>
          <div className={label}>{t("Identity")}</div>
          <dl className="mt-1.5 grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 text-xs">
            <Fact k={t("Persona")} v={personaLabel(p)} />
            <Fact k={t("Browser version")} v={t(version.label)} />
            <Fact k={t("Fingerprint seed")} v={p.fingerprint} mono />
            {p.fingerprintProfile && <Fact k={t("Captured fingerprint")} v={p.fingerprintProfileMeta?.label || t("captured profile")} />}
            <Fact k={t("Timezone")} v={p.timezone || (p.geoip ? t("follows the proxy") : t("persona default"))} />
            <Fact k={t("Language")} v={p.acceptLanguage || (p.geoip ? t("follows the proxy") : t("persona default"))} />
          </dl>
        </div>

        <div className={box}>
          <div className={label}>{t("Browser data")}</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button className={ghost} onClick={props.onOpenData}>
              {t("Open data folder")}
            </button>
            <button className={ghost} onClick={props.onImportCookies}>
              {t("Import cookies…")}
            </button>
            <button className={ghost} onClick={props.onClearCache} disabled={props.running}>
              {t("Clear cache")}
            </button>
          </div>
        </div>

        {(p.notes?.trim() || (p.tags ?? []).length > 0) && (
          <div className={box}>
            <div className={label}>{t("Notes")}</div>
            {p.notes?.trim() && <p className="mt-1.5 whitespace-pre-wrap break-words text-xs text-fog/70">{p.notes}</p>}
            {(p.tags ?? []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {(p.tags ?? []).map((tag) => (
                  <button key={tag} className="rounded bg-elevate px-1.5 py-px text-[11px] text-fog/60 hover:text-fog" onClick={() => props.onFilterTag(tag)}>
                    #{tag}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <dl className="grid grid-cols-[6.5rem_1fr] gap-x-2 gap-y-1 px-1 text-[11px] text-fog/45">
          <Fact k={t("Created")} v={when(p.createdAt)} />
          <Fact k={t("Changed")} v={when(p.updatedAt)} />
        </dl>
      </div>
    </aside>
  );
}
