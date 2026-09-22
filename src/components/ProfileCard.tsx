"use client";

// One profile in the list.
//
// What a card has to answer at a glance, for someone who launches a dozen of these a day: which one
// is this (two cards both named "test" used to differ only by seed), what will it launch (latest,
// or a pin — the thing that broke free launches), where does its traffic go, and did its last launch
// go wrong. A launch error stays ON THE CARD until dismissed, with the one action that fixes it;
// it used to be a 3.5-second toast of raw JSON at the bottom of the window.

import type { DownloadProgress } from "@/lib/ipc";
import type { Profile } from "@/types/profile";
import { actionLabel, type LaunchNotice, type NoticeAction } from "@/lib/launchError";
import { displayName, pinRefusedOnFree, proxySummary, relativeTime, versionInfo } from "@/lib/profileList";
import Menu from "./Menu";

export interface CardProps {
  profile: Profile;
  running: boolean;
  launching: boolean;
  /** This profile's download, while its first launch fetches a build. */
  download: DownloadProgress | null;
  notice?: LaunchNotice;
  /** What "latest" resolves to and the plan, when known — for the pin warning. */
  current?: { version?: string; major?: number; plan?: string };
  onLaunch: () => void;
  onStop: () => void;
  onEdit: (field?: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onExport: () => void;
  onOpenData: () => void;
  onDismissNotice: () => void;
  onNoticeAction: (a: NoticeAction) => void;
  onCopy: (text: string) => void;
  /** Arrow-key movement between cards is the page's job (it knows the grid). */
  onArrow: (key: string) => void;
}

type Tone = "plain" | "accent" | "iris" | "warn";

function Chip({ children, tone = "plain", title }: { children: React.ReactNode; tone?: Tone; title?: string }) {
  const cls: Record<Tone, string> = {
    plain: "bg-elevate text-fog/55",
    accent: "bg-accent/10 text-accent",
    iris: "bg-iris/10 text-iris",
    warn: "bg-warn/10 text-warn",
  };
  return (
    <span title={title} className={`max-w-full truncate rounded-md px-1.5 py-0.5 text-[10px] ${cls[tone]}`}>
      {children}
    </span>
  );
}

const btnGhost =
  "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition";

export default function ProfileCard(props: CardProps) {
  const { profile: p, running, launching, download, notice, current } = props;
  const name = displayName(p);
  const launched = relativeTime(p.lastLaunchedAt);
  const version = versionInfo(p.browserVersion);
  const pinWarn = current?.plan === "free" && pinRefusedOnFree(p.browserVersion, current);
  const proxy = proxySummary(p.proxy);
  const note = p.notes?.trim().split(/\r?\n/)[0];

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (!running && !launching) props.onLaunch();
    } else if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      props.onEdit();
    } else if (e.key === "Delete") {
      e.preventDefault();
      if (!running) props.onDelete();
    } else if (e.key.startsWith("Arrow")) {
      e.preventDefault();
      props.onArrow(e.key);
    }
  }

  return (
    <article
      data-card={p.id}
      tabIndex={0}
      aria-label={`${name}${running ? " (running)" : ""}`}
      onKeyDown={onKeyDown}
      className={
        // focus-within:z-20 — an open ⋯ menu holds focus, and without raising its card the NEXT card
        // (positioned, later in the DOM) painted over the menu's lower items.
        "group relative flex flex-col rounded-xl border bg-surface/80 p-4 outline-none transition duration-200 focus-within:z-20 " +
        "focus-visible:border-accent/60 focus-visible:ring-2 focus-visible:ring-accent/40 " +
        (running
          ? "border-accent/40"
          : "border-line hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-[0_10px_30px_-14px_rgba(56,224,214,0.35)]")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium" title={name}>
            {name}
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-fog/40">
            <span
              className="shrink-0"
              title={p.lastLaunchedAt ? `Last launched ${new Date(p.lastLaunchedAt).toLocaleString()}` : undefined}
            >
              {launched ? `Launched ${launched}` : "Never launched"}
            </span>
            <span aria-hidden className="text-fog/20">
              ·
            </span>
            <span className="truncate font-mono" title={`Fingerprint seed ${p.fingerprint}`}>
              {p.fingerprint}
            </span>
          </div>
        </div>
        {running && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] text-accent">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> running
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <Chip
          tone={pinWarn ? "warn" : version.kind === "latest" ? "plain" : "iris"}
          title={
            pinWarn
              ? "The free plan only runs the latest build, so this pin will be refused. Change it to Latest, or use a Pro key."
              : version.kind === "latest"
                ? "Launches the newest build for your licence."
                : "Launches this build rather than the latest."
          }
        >
          {pinWarn ? "▲ " : ""}
          {version.label}
        </Chip>
        {proxy && (
          <Chip title="Proxy (credentials hidden)">
            {proxy}
          </Chip>
        )}
        {p.platform && <Chip>{p.platform}</Chip>}
        {p.timezone && <Chip>{p.timezone}</Chip>}
        {p.geoip && (
          <Chip tone="accent" title="Timezone, language and location follow the proxy's exit region">
            geoip
          </Chip>
        )}
        {p.fingerprintProfile && (
          <Chip tone="accent" title={p.fingerprintProfileMeta?.label || "Captured fingerprint"}>
            captured fp
          </Chip>
        )}
        {p.fingerprintNoise === false && <Chip>noise off</Chip>}
        {p.disableGpuFingerprint && <Chip>real gpu</Chip>}
        {p.canvasBridgeUrl && <Chip tone="accent">bridge</Chip>}
        {(p.tags || []).map((t) => (
          <Chip key={t}>#{t}</Chip>
        ))}
      </div>

      {note && (
        <p className="mt-2 truncate text-[11px] text-fog/45" title={p.notes}>
          {note}
        </p>
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-4">
        {running ? (
          <button
            className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-semibold text-fog hover:bg-elevate"
            onClick={props.onStop}
          >
            Stop
          </button>
        ) : launching ? (
          <div className="min-w-0 flex-1" role="status" aria-live="polite">
            {download ? (
              <>
                <div className="flex items-center justify-between gap-2 text-[11px] font-medium text-fog/70">
                  <span className="truncate">Downloading build {download.version.split(".")[0]}…</span>
                  <span className="shrink-0 tabular-nums">
                    {download.pct}% · {download.seenMB}/{download.totalMB} MB
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line">
                  <div
                    className="h-full rounded-full bg-sheen transition-[width] duration-200"
                    style={{ width: `${download.pct}%` }}
                  />
                </div>
              </>
            ) : (
              <div className="rounded-lg bg-elevate px-3 py-1.5 text-center text-xs font-semibold text-fog/70">
                <span className="mr-1.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent align-middle" />
                Launching…
              </div>
            )}
          </div>
        ) : (
          <button
            className="flex-1 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95"
            onClick={props.onLaunch}
          >
            Launch
          </button>
        )}
        <button className={btnGhost} onClick={() => props.onEdit()}>
          Edit
        </button>
        <Menu
          label={`More actions for ${name}`}
          items={[
            { label: "Duplicate", onSelect: props.onDuplicate },
            { label: "Export…", onSelect: props.onExport },
            { label: "Open data folder", onSelect: props.onOpenData },
            "separator",
            {
              label: "Delete…",
              onSelect: props.onDelete,
              danger: true,
              disabled: running,
              hint: running ? "Stop it first — its browser has the data open." : undefined,
              shortcut: "Del",
            },
          ]}
        />
      </div>

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={
            "mt-3 rounded-lg border px-3 py-2 text-xs " +
            (notice.tone === "error" ? "border-danger/30 bg-danger/5" : "border-warn/30 bg-warn/5")
          }
        >
          <div className="flex items-start gap-2">
            <span aria-hidden className={"mt-px " + (notice.tone === "error" ? "text-danger" : "text-warn")}>
              {notice.tone === "error" ? "●" : "▲"}
            </span>
            <div className="min-w-0 flex-1">
              <p className={"font-medium " + (notice.tone === "error" ? "text-danger" : "text-warn")}>{notice.title}</p>
              {notice.lines.map((l, i) => (
                <p key={i} className="mt-1 break-words leading-relaxed text-fog/60">
                  {l}
                </p>
              ))}
              {(notice.action || notice.raw) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {notice.action && (
                    <button
                      className="rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-medium text-fog/85 hover:bg-elevate"
                      onClick={() => props.onNoticeAction(notice.action!)}
                    >
                      {actionLabel(notice.action)}
                    </button>
                  )}
                  {notice.raw && (
                    <button
                      className="rounded-md px-2 py-1 text-[11px] text-fog/45 hover:bg-elevate hover:text-fog/80"
                      onClick={() => props.onCopy(notice.raw!)}
                    >
                      Copy details
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              className="-mr-1 shrink-0 rounded px-1 text-fog/35 hover:text-fog"
              onClick={props.onDismissNotice}
              aria-label="Dismiss"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
