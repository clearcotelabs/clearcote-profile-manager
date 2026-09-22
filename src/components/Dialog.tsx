"use client";

// The one dialog frame every modal in the app uses.
//
// The editor, the fingerprint library and Settings each used to hand-roll their own overlay, and
// each behaved differently: Esc closed one of them, backdrop clicks closed another, none trapped
// focus, and Settings had no height cap at all — so on a short window its top and its Done button
// sat off-screen with nothing able to scroll them back. Owning that behaviour in one place is what
// makes the bug impossible rather than fixed three times.
//
// Behaviour, for every dialog:
//   - capped to the viewport; a "panel" dialog scrolls its body, a "fit" dialog scrolls as a whole
//   - Esc closes the TOPMOST dialog only (the library opens over the editor), unless something inside
//     already used the key (it calls preventDefault — e.g. Esc clearing a search box)
//   - a click that starts AND ends on the backdrop closes it; a text selection dragged out does not
//   - Tab stays inside the dialog, and focus returns to whatever opened it
//   - the page behind does not scroll while any dialog is open

import { useEffect, useRef } from "react";

/** Open dialogs, innermost last. Module-level because stacked dialogs are separate components. */
const stack: symbol[] = [];
let lockCount = 0;
let savedOverflow = "";

/** True while any dialog is open — page-level shortcuts stand down so they never fire behind one. */
export function dialogOpen(): boolean {
  return stack.length > 0;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  onClose: () => void;
  /** id of the element that names the dialog (usually its <h2>). */
  labelledBy?: string;
  /** "panel": fixed-height frame whose body scrolls (editor, settings). "fit": sized to its content,
   *  and the whole frame scrolls when the window is too short for it (library, confirmations). */
  variant?: "panel" | "fit";
  /** Width / height caps, e.g. "max-w-4xl max-h-[720px]". */
  className?: string;
  /** "top" stacks above a "base" dialog (a confirmation over the editor). */
  layer?: "base" | "top";
  /** Element to focus on open. Defaults to the frame itself, so Tab starts at the first control. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  dismissOnBackdrop?: boolean;
  children: React.ReactNode;
}

export default function Dialog({
  onClose,
  labelledBy,
  variant = "panel",
  className = "",
  layer = "base",
  initialFocus,
  dismissOnBackdrop = true,
  children,
}: DialogProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  // The latest onClose, without re-running the mount effect (which would re-steal focus).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const me = Symbol("dialog");
    stack.push(me);
    if (lockCount++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (initialFocus?.current ?? frameRef.current)?.focus({ preventScroll: true });

    const trapTab = (e: KeyboardEvent) => {
      const root = frameRef.current;
      if (!root) return;
      const els = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (els.length === 0) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const active = document.activeElement;
      if (!root.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === "Tab") {
        trapTab(e);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      const i = stack.lastIndexOf(me);
      if (i >= 0) stack.splice(i, 1);
      if (--lockCount === 0) document.body.style.overflow = savedOverflow;
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
    // Mount-only by design: re-running would push a second stack entry and re-steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const frame =
    variant === "panel"
      ? "flex h-full w-full flex-col overflow-hidden"
      : "flex max-h-full w-full flex-col overflow-y-auto";

  return (
    <div
      className={
        "fixed inset-0 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm sm:p-6 " +
        (layer === "top" ? "z-50" : "z-40")
      }
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (dismissOnBackdrop && downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={frameRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`${frame} rounded-2xl border border-line bg-surface shadow-2xl outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/** Pinned title row: the heading, anything between (status chips), and a close button. */
export function DialogHeader({
  id,
  title,
  onClose,
  children,
}: {
  id: string;
  title: React.ReactNode;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-none items-center gap-3 border-b border-line px-5 py-3">
      <h2 id={id} className="min-w-0 truncate text-base font-semibold">
        {title}
      </h2>
      {children}
      <span className="flex-1" />
      <button className="shrink-0 rounded-md px-1 text-fog/40 hover:text-fog" onClick={onClose} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

/** Pinned action row. */
export function DialogFooter({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={"flex flex-none items-center gap-2 border-t border-line bg-ink/40 px-5 py-2.5 " + className}>
      {children}
    </div>
  );
}
