"use client";

// A small overflow menu ("⋯"). Keeps rarely-used and destructive actions off the card face, where
// "Del" sat one click from "Dup".
//
// Keyboard: opening focuses the first item; ↑/↓ move, Home/End jump, Enter activates, Esc or Tab
// closes and hands focus back to the button. It opens upward when it doesn't fit below.
//
// The list is portalled to <body> with fixed coordinates, so a scrolling ancestor (the table's
// overflow-x-auto wrapper) can't clip it. Scrolling or resizing closes it rather than leaving it
// floating away from its button.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip — why an item is disabled, for instance. */
  hint?: string;
  shortcut?: string;
}

export default function Menu({
  label,
  items,
  quiet = false,
  align = "right",
  trigger,
  triggerClassName,
}: {
  label: string;
  items: (MenuItem | "separator")[];
  /** A borderless trigger, for inside a heading. */
  quiet?: boolean;
  /** Which edge of the trigger the menu lines up with — "left" near the page's left edge. */
  align?: "left" | "right";
  /** What the trigger shows instead of ⋯, and its classes (a split button's arrow, say). */
  trigger?: React.ReactNode;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const enabled = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  function openMenu() {
    setPos({ opacity: 0 }); // placed below once its height is known (still focusable, unlike hidden)
    setOpen(true);
  }

  useLayoutEffect(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!open || !r || !listRef.current) return;
    const below = window.innerHeight - r.bottom;
    const up = below < listRef.current.offsetHeight + 8 && r.top > below;
    setPos({
      ...(align === "left" ? { left: r.left } : { right: document.documentElement.clientWidth - r.right }),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, [open, align]);
  function close(refocus = true) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    enabled()[0]?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!listRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onMove = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    const els = enabled();
    const i = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      els[(i + 1) % els.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      els[(i - 1 + els.length) % els.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      els[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      els[els.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.preventDefault(); // ours — nothing behind should also react to it
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close(false);
    }
  }

  return (
    <div className={"relative " + (open ? "z-30" : "")}>
      <button
        ref={btnRef}
        className={
          triggerClassName ??
          (quiet
            ? "rounded-md px-1.5 py-0.5 text-xs text-fog/35 transition hover:bg-elevate hover:text-fog"
            : "rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-fog/70 transition hover:bg-elevate hover:text-fog")
        }
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
      >
        {trigger ?? "⋯"}
      </button>
      {open && createPortal(
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          style={pos}
          className="fixed z-50 min-w-[190px] rounded-xl border border-line-strong bg-surface p-1 shadow-2xl"
        >
          {items.map((it, i) =>
            it === "separator" ? (
              <div key={`sep-${i}`} role="separator" className="my-1 border-t border-line" />
            ) : (
              <button
                key={it.label}
                role="menuitem"
                disabled={it.disabled}
                title={it.hint}
                onClick={() => {
                  close();
                  it.onSelect();
                }}
                className={
                  "flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-[13px] outline-none disabled:cursor-not-allowed disabled:opacity-40 " +
                  (it.danger
                    ? "text-danger hover:bg-danger/10 focus:bg-danger/10"
                    : "text-fog/80 hover:bg-elevate focus:bg-elevate")
                }
              >
                <span className="flex-1">{it.label}</span>
                {it.shortcut && <kbd className="font-sans text-[11px] text-fog/35">{it.shortcut}</kbd>}
              </button>
            ),
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
