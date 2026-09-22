"use client";

// A group's heading: click it to fold the group away; its ⋯ menu filters to it, renames it (every
// profile in it at once — groups used to be free text you retyped on each profile), moves it, or
// dissolves it.

import Menu, { type MenuItem } from "./Menu";

export default function GroupHeader({
  name,
  count,
  running,
  collapsed,
  isGroup,
  canMoveUp,
  canMoveDown,
  onToggle,
  onFilter,
  onRename,
  onMove,
  onUngroup,
}: {
  name: string;
  count: number;
  running: number;
  collapsed: boolean;
  /** False for the "No group" section, which cannot be renamed or moved. */
  isGroup: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onFilter: () => void;
  onRename: () => void;
  onMove: (dir: -1 | 1) => void;
  onUngroup: () => void;
}) {
  const items: (MenuItem | "separator")[] = [{ label: "Show only this group", onSelect: onFilter }];
  if (isGroup) {
    items.push(
      { label: "Rename group…", onSelect: onRename },
      { label: "Move up", onSelect: () => onMove(-1), disabled: !canMoveUp },
      { label: "Move down", onSelect: () => onMove(1), disabled: !canMoveDown },
      "separator",
      { label: "Ungroup these profiles", onSelect: onUngroup },
    );
  }
  return (
    <div className="mb-2 flex items-center gap-2">
      <h2 className="min-w-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 items-center gap-2 rounded-md py-0.5 pr-1.5 text-[11px] font-medium uppercase tracking-wide text-fog/45 hover:text-fog/80"
        >
          <span aria-hidden className={"inline-block transition-transform " + (collapsed ? "" : "rotate-90")}>
            ›
          </span>
          <span className="truncate" data-group-name>
            {name}
          </span>
          <span className="font-normal normal-case tracking-normal text-fog/30">
            {count}
            {running > 0 && <span className="text-accent/80"> · {running} running</span>}
          </span>
        </button>
      </h2>
      <Menu quiet align="left" label={`Group ${name}`} items={items} />
    </div>
  );
}
