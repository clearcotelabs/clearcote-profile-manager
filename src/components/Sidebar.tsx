"use client";

// The workspace's left column: which page (Profiles, Proxies), which list (all, running, needs
// attention, used this week), the groups and tags to narrow it, and every browser open right now.
//
// No <nav>, <section> or <h3> in here on purpose: the editor's category rail is the page's only
// <nav>, the group sections are `main section`, and the editor's panel title is the first <h3> —
// the UI tests (and screen-reader landmarks) rely on each.

import { t } from "@/lib/i18n";
import { VIEW_LABELS, type ViewKey } from "@/lib/workspace";

export type PageKey = "profiles" | "proxies" | "tasks";

export interface RunningItem {
  id: string;
  name: string;
  where: "local" | "cloud";
  /** "Berlin · 14 min" — whatever is known. */
  detail?: string;
  stopping?: boolean;
}

const item =
  "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition outline-none focus-visible:ring-2 focus-visible:ring-accent/50";
const on = "bg-elevate text-fog";
const off = "text-fog/65 hover:bg-elevate hover:text-fog";
const head = "px-2.5 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/35";

function Count({ n, tone }: { n: number; tone?: "warn" }) {
  if (!n) return null;
  return (
    <span aria-hidden className={"shrink-0 text-[11px] tabular-nums " + (tone === "warn" ? "text-warn" : "text-fog/35")}>
      {n}
    </span>
  );
}

export default function Sidebar(props: {
  page: PageKey;
  onPage: (p: PageKey) => void;
  view: ViewKey;
  onView: (v: ViewKey) => void;
  counts: Record<ViewKey, number>;
  groups: { key: string; name: string; count: number }[];
  group: string | null;
  onGroup: (g: { key: string; name: string } | null) => void;
  tags: { tag: string; count: number }[];
  tag: string | null;
  onTag: (tag: string | null) => void;
  proxies: number;
  /** Saved tasks (desktop only; undefined hides the entry). */
  tasks?: number;
  running: RunningItem[];
  onStopRunning: (id: string) => void;
  onOpenRunning: (id: string) => void;
  /** Bottom row: the build pill, theme, shortcuts, settings. */
  footer: React.ReactNode;
}) {
  const views: ViewKey[] = ["all", "running", "attention", "recent"];
  const profilesPage = props.page === "profiles";
  return (
    <aside
      aria-label={t("Workspace")}
      className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-panel/60 backdrop-blur"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className={head}>{t("Library")}</div>
        <button
          className={`${item} ${profilesPage && props.view === "all" && !props.group && !props.tag ? on : off}`}
          onClick={() => {
            props.onPage("profiles");
            props.onView("all");
            props.onGroup(null);
            props.onTag(null);
          }}
          aria-current={profilesPage && props.view === "all" && !props.group && !props.tag ? "page" : undefined}
        >
          <span className="truncate">{t(VIEW_LABELS.all)}</span>
          <Count n={props.counts.all} />
        </button>
        {views.slice(1).map((v) => {
          const active = profilesPage && props.view === v;
          const n = props.counts[v];
          return (
            <button
              key={v}
              className={`${item} ${active ? on : off}`}
              aria-pressed={active}
              title={v === "running" ? t("Show only profiles whose browser is open") : undefined}
              onClick={() => {
                props.onPage("profiles");
                // A second click goes back to every profile, as the old Running toggle did.
                props.onView(active ? "all" : v);
              }}
            >
              {/* "Running · 2" keeps the old toolbar toggle's accessible name. */}
              {v === "running" ? (
                <span className="truncate">
                  {t(VIEW_LABELS.running)}
                  {n ? ` · ${n}` : ""}
                </span>
              ) : (
                <>
                  <span className="truncate">{t(VIEW_LABELS[v])}</span>
                  <Count n={n} tone={v === "attention" ? "warn" : undefined} />
                </>
              )}
            </button>
          );
        })}
        <button
          className={`${item} ${props.page === "proxies" ? on : off}`}
          aria-current={props.page === "proxies" ? "page" : undefined}
          onClick={() => props.onPage("proxies")}
        >
          <span className="truncate">{t("Proxies")}</span>
          <Count n={props.proxies} />
        </button>
        {props.tasks !== undefined && (
          <button
            className={`${item} ${props.page === "tasks" ? on : off}`}
            aria-current={props.page === "tasks" ? "page" : undefined}
            onClick={() => props.onPage("tasks")}
            data-nav-tasks="1"
          >
            <span className="truncate">{t("Tasks")}</span>
            <Count n={props.tasks} />
          </button>
        )}

        {props.groups.length > 0 && (
          <>
            <div className={head}>{t("Groups")}</div>
            {props.groups.map((g) => {
              const active = profilesPage && props.group === g.key;
              return (
                <button
                  key={g.key}
                  className={`${item} ${active ? on : off}`}
                  aria-pressed={active}
                  aria-label={t("{name} (group)", { name: g.name })}
                  title={t("Show only this group")}
                  onClick={() => {
                    props.onPage("profiles");
                    props.onGroup(active ? null : { key: g.key, name: g.name });
                  }}
                >
                  <span className="truncate">{g.name}</span>
                  <Count n={g.count} />
                </button>
              );
            })}
          </>
        )}

        {props.tags.length > 0 && (
          <>
            <div className={head}>{t("Tags")}</div>
            <div className="flex flex-wrap gap-1 px-2">
              {props.tags.slice(0, 30).map(({ tag, count }) => {
                const active = profilesPage && props.tag?.toLowerCase() === tag.toLowerCase();
                return (
                  <button
                    key={tag}
                    className={
                      "rounded-md px-1.5 py-0.5 text-[11px] transition outline-none focus-visible:ring-2 focus-visible:ring-accent/50 " +
                      (active ? "bg-accent/15 text-accent" : "bg-elevate text-fog/60 hover:text-fog")
                    }
                    aria-pressed={active}
                    aria-label={t("Show only profiles tagged #{tag}", { tag })}
                    onClick={() => {
                      props.onPage("profiles");
                      props.onTag(active ? null : tag);
                    }}
                  >
                    #{tag} <span className="text-fog/35">{count}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {props.running.length > 0 && (
          <>
            <div className={head}>{t("Open now")}</div>
            <ul className="flex flex-col gap-1 px-1" data-running-dock>
              {props.running.map((r) => (
                <li key={r.id} className="flex items-center gap-2 rounded-lg border border-line bg-ink/40 px-2 py-1.5">
                  <span
                    aria-hidden
                    className={"h-1.5 w-1.5 shrink-0 rounded-full " + (r.where === "cloud" ? "bg-iris" : "bg-accent animate-pulse")}
                  />
                  <button
                    className="min-w-0 flex-1 text-left outline-none focus-visible:underline"
                    onClick={() => props.onOpenRunning(r.id)}
                    title={r.where === "cloud" ? t("Open its cloud window") : t("Show it in the list")}
                  >
                    <div className="truncate text-[12px] font-medium">{r.name}</div>
                    <div className="truncate text-[10px] text-fog/40">
                      {r.where === "cloud" ? t("in the cloud") : t("on this computer")}
                      {r.detail ? ` · ${r.detail}` : ""}
                    </div>
                  </button>
                  <button
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] text-fog/50 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    onClick={() => props.onStopRunning(r.id)}
                    disabled={r.stopping}
                    aria-label={t("Close the browser of {name}", { name: r.name })}
                    title={t("Close the browser of {name}", { name: r.name })}
                  >
                    ■
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2.5">{props.footer}</div>
    </aside>
  );
}
