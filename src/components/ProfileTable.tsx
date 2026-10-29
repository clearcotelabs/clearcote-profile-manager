"use client";

// The list as a dense table, for people with dozens or hundreds of profiles: one line each, the
// facts that tell profiles apart in columns, and the same ⋯ menu as a card. Clicking a row opens
// its details beside the list.

import { t } from "@/lib/i18n";
import { displayName, geoLabel, proxySummary, relativeTime, versionInfo } from "@/lib/profileList";
import { personaLabel } from "@/lib/workspace";
import Menu from "./Menu";
import { profileMenuItems, type CardProps } from "./ProfileCard";

export interface RowProps extends CardProps {
  /** Why this profile needs attention, if it does (the Issues column). */
  attention: { text: string }[];
  /** The row whose details are open. */
  open: boolean;
}

function Status({ p }: { p: RowProps }) {
  if (p.cloud) return <span title={t("Running on Clearcote's servers")} className="block h-2 w-2 rounded-full bg-iris" />;
  if (p.running) return <span title={t("Open on this computer")} className="block h-2 w-2 animate-pulse rounded-full bg-accent" />;
  if (p.launching || p.cloudStarting) return <span title={t("Launching…")} className="block h-2 w-2 animate-pulse rounded-full bg-fog/40" />;
  if (p.attention.length) return <span title={p.attention[0].text} className="block h-2 w-2 rounded-full bg-warn" />;
  return <span className="block h-2 w-2 rounded-full bg-line-strong" />;
}

function Row(props: RowProps) {
  const p = props.profile;
  const name = displayName(p);
  const geo = geoLabel(p);
  const proxy = proxySummary(p.proxy);
  const used = relativeTime(p.lastLaunchedAt);
  const version = versionInfo(p.browserVersion);
  const tags = p.tags ?? [];
  const busyHere = props.running || props.launching || props.cloudStarting;

  function onKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Enter") {
      e.preventDefault();
      props.onDetails?.();
    } else if (e.key === " ") {
      e.preventDefault();
      props.onToggleSelect({ range: e.shiftKey });
    } else if (e.key === "e" || e.key === "E") {
      e.preventDefault();
      props.onEdit();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      props.onArrow(e.key);
    }
  }

  return (
    <tr
      data-row={p.id}
      tabIndex={0}
      aria-selected={props.selected}
      onKeyDown={onKeyDown}
      onClick={(e) => {
        // Controls inside the row do their own thing.
        if ((e.target as HTMLElement).closest("button, input, a, [role=menu]")) return;
        props.onDetails?.();
      }}
      className={
        "group cursor-pointer border-b border-line outline-none transition focus-visible:bg-accent/5 " +
        (props.open ? "bg-elevate " : props.selected ? "bg-accent/5 " : "hover:bg-elevate/60 ")
      }
    >
      <td className="w-8 py-2 pl-3 pr-1">
        <input
          type="checkbox"
          aria-label={t("Select {name}", { name })}
          checked={props.selected}
          onChange={() => {}}
          onClick={(e) => props.onToggleSelect({ range: e.shiftKey })}
          className={
            "h-3.5 w-3.5 accent-[#38e0d6] transition-opacity " +
            (props.selecting || props.selected ? "opacity-100" : "opacity-0 focus:opacity-100 group-hover:opacity-100")
          }
        />
      </td>
      <td className="w-4 px-1">
        <Status p={props} />
      </td>
      <td className="max-w-[16rem] px-2 py-2">
        <div className="truncate text-[13px] font-medium" title={name}>
          {name}
        </div>
        {p.group && <div className="truncate text-[11px] text-fog/40">{p.group}</div>}
      </td>
      <td className="max-w-[13rem] px-2 py-2 text-[12px]">
        {props.cloud ? (
          <span className="text-iris">{props.cloud.exit ?? t("cloud")}</span>
        ) : geo ? (
          <span className="block truncate text-accent" title={t(geo.title)}>
            {geo.text}
          </span>
        ) : proxy ? (
          <span className="block truncate font-mono text-[11px] text-fog/50" title={proxy}>
            {proxy}
          </span>
        ) : (
          <span className="text-fog/35">{t("this computer")}</span>
        )}
      </td>
      <td className="hidden max-w-[12rem] px-2 py-2 text-[12px] text-fog/60 xl:table-cell">
        <span className="block truncate">{personaLabel(p)}</span>
        {version.kind !== "latest" && <span className="block truncate text-[11px] text-iris">{t(version.label)}</span>}
      </td>
      <td className="hidden max-w-[12rem] px-2 py-2 lg:table-cell">
        <div className="flex flex-wrap gap-1">
          {tags.slice(0, 3).map((tag) => (
            <button
              key={tag}
              className="rounded bg-elevate px-1.5 py-px text-[10px] text-fog/55 hover:text-fog"
              onClick={() => props.onFilterTag(tag)}
              title={t("Show only profiles tagged #{tag}", { tag })}
            >
              #{tag}
            </button>
          ))}
          {tags.length > 3 && <span className="text-[10px] text-fog/35">+{tags.length - 3}</span>}
        </div>
      </td>
      <td className="whitespace-nowrap px-2 py-2 text-[12px] text-fog/45">{used ?? t("never")}</td>
      <td className="px-2 py-2">
        {props.attention.length > 0 && (
          <span className="whitespace-nowrap rounded bg-warn/10 px-1.5 py-px text-[11px] text-warn" title={props.attention.map((a) => a.text).join("\n")}>
            ▲ {props.attention.length}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right">
        <div className="inline-flex items-center gap-1">
          {props.cloud ? (
            <button
              className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-semibold hover:bg-elevate disabled:opacity-50"
              onClick={props.onCloudOpen}
              disabled={props.cloud.status !== "running"}
            >
              {t("Open window")}
            </button>
          ) : props.running ? (
            <button className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-semibold hover:bg-elevate" onClick={props.onStop}>
              {t("Stop")}
            </button>
          ) : (
            <button
              className="rounded-md bg-sheen px-2.5 py-1 text-[11px] font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-50"
              onClick={props.onLaunch}
              disabled={busyHere}
            >
              {props.launching ? (props.download ? `${props.download.pct}%` : t("Launching…")) : t("Launch")}
            </button>
          )}
          <Menu label={t("More actions for {name}", { name })} items={profileMenuItems(props)} />
        </div>
      </td>
    </tr>
  );
}

export default function ProfileTable({ rows }: { rows: RowProps[] }) {
  const th = "px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40";
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface/70">
      <table className="w-full min-w-[640px] border-collapse" data-profile-table>
        <thead className="border-b border-line">
          <tr>
            <th className="w-8 py-2 pl-3 pr-1" />
            <th className="w-4 px-1" />
            <th className={th}>{t("Name")}</th>
            <th className={th}>{t("Exit")}</th>
            <th className={th + " hidden xl:table-cell"}>{t("Persona")}</th>
            <th className={th + " hidden lg:table-cell"}>{t("Tags")}</th>
            <th className={th}>{t("Last used")}</th>
            <th className={th}>
              <span className="sr-only">{t("Issues")}</span>
            </th>
            <th className="py-2 pl-2 pr-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Row key={r.profile.id} {...r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
