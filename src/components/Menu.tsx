"use client";

// A small overflow menu ("⋯"). Keeps rarely-used and destructive actions off the card face, where
// "Del" sat one click from "Dup".
//
// Keyboard: opening focuses the first item; ↑/↓ move, Home/End jump, Enter activates, Esc or Tab
// closes and hands focus back to the button. It opens upward when there is no room below.

import { useEffect, useId, useRef, useState } from "react";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip — why an item is disabled, for instance. */
  hint?: string;
  shortcut?: string;
}

export default function Menu({ label, items }: { label: string; items: (MenuItem | "separator")[] }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const enabled = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  function openMenu() {
    const r = btnRef.current?.getBoundingClientRect();
    setUp(!!r && window.innerHeight - r.bottom < 220 && r.top > 220);
    setOpen(true);
  }
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
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
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
        className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-fog/70 transition hover:bg-elevate hover:text-fog"
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
        ⋯
      </button>
      {open && (
        <div
          ref={listRef}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onKeyDown}
          className={
            "absolute right-0 min-w-[190px] rounded-xl border border-line-strong bg-surface p-1 shadow-2xl " +
            (up ? "bottom-full mb-1" : "top-full mt-1")
          }
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
        </div>
      )}
    </div>
  );
}
