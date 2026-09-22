"use client";

// In-app confirmation, replacing window.confirm().
//
// The native dialog blocks the renderer, looks like nothing else in the app, cannot say which
// button is the dangerous one, and on Windows titles itself with the page origin. This one is
// promise-based so a call site stays a single line:
//
//   if (!(await confirm({ title: "Delete “x”?", confirmLabel: "Delete", tone: "danger" }))) return;
//
// The SAFE button has focus when it opens, so Enter on a reflex never deletes anything.

import { createContext, useCallback, useContext, useId, useRef, useState } from "react";
import Dialog from "./Dialog";

export interface ConfirmOptions {
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<ConfirmFn>(async () => false);

export function useConfirm(): ConfirmFn {
  return useContext(Ctx);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open answers the first "no" rather than leaving its
        // caller awaiting a promise that can never settle.
        setReq((prev) => {
          prev?.resolve(false);
          return { ...o, resolve };
        });
      }),
    [],
  );

  const settle = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {req && <ConfirmDialog opts={req} onSettle={settle} />}
    </Ctx.Provider>
  );
}

function ConfirmDialog({ opts, onSettle }: { opts: ConfirmOptions; onSettle: (v: boolean) => void }) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const danger = opts.tone === "danger";
  return (
    <Dialog
      onClose={() => onSettle(false)}
      labelledBy={titleId}
      variant="fit"
      layer="top"
      className="max-w-md"
      initialFocus={cancelRef}
    >
      <div className="px-5 pb-4 pt-5">
        <h2 id={titleId} className="text-base font-semibold">
          {opts.title}
        </h2>
        {opts.body && <div className="mt-2 text-sm leading-relaxed text-fog/60">{opts.body}</div>}
      </div>
      <div className="flex flex-none justify-end gap-2 border-t border-line bg-ink/40 px-5 py-3">
        <button
          ref={cancelRef}
          className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate"
          onClick={() => onSettle(false)}
        >
          {opts.cancelLabel || "Cancel"}
        </button>
        <button
          className={
            "rounded-lg px-3.5 py-1.5 text-sm font-semibold " +
            // text-surface flips with the theme exactly as --c-danger does (dark text on the light rose,
            // white on the deep one), so the button reads ~7:1 / ~6:1 instead of white-on-rose-400.
            (danger ? "bg-danger text-surface hover:opacity-90" : "bg-sheen text-[#07080a] hover:opacity-95")
          }
          onClick={() => onSettle(true)}
        >
          {opts.confirmLabel || "OK"}
        </button>
      </div>
    </Dialog>
  );
}
