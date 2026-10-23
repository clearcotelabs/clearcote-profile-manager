"use client";

// Profile templates: "Save as template" (from a card's ⋯ menu) and "Manage templates" (from the New
// profile menu). What a template copies and what it makes fresh is decided in src/lib/templates.ts.

import { useId, useRef, useState } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import { describeTemplate, findTemplateByName, suggestTemplateName, type ProfileTemplate } from "@/lib/templates";
import type { Profile } from "@/types/profile";

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";
const btnGhost = "rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate";
const btnPrimary = "rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40";

/** Two side-by-side choices, as radio buttons. */
function Choice<T extends string>({
  legend,
  value,
  onChange,
  options,
}: {
  legend: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; title: string; sub: string }[];
}) {
  const name = useId();
  return (
    <fieldset className="mt-4 rounded-lg border border-line px-3 pb-3 pt-1">
      <legend className="px-1 text-[11px] font-medium uppercase tracking-wide text-fog/45">{legend}</legend>
      <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <label
            key={o.value}
            className={
              "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm " +
              (value === o.value ? "border-accent/70 bg-accent/10" : "border-line hover:border-line-strong")
            }
          >
            <input
              type="radio"
              name={name}
              className="mt-1 accent-[#38e0d6]"
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            <span>
              <span className="block font-medium text-fog">{o.title}</span>
              <span className="block text-[11px] text-fog/50">{o.sub}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const proxyLabel = (p?: string) => (p ? p.replace(/^[a-z0-9+.-]+:\/\//i, "").replace(/^[^@/]*@/, "") : "");

export function SaveTemplateDialog({
  profile,
  templates,
  onSave,
  onClose,
}: {
  profile: Profile;
  templates: ProfileTemplate[];
  onSave: (choice: { name: string; proxy: ProfileTemplate["proxy"]; gpu: ProfileTemplate["gpu"] }) => Promise<void> | void;
  onClose: () => void;
}) {
  const titleId = useId();
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(() => suggestTemplateName(profile));
  const existing = findTemplateByName(templates, name);
  const [proxy, setProxy] = useState<ProfileTemplate["proxy"]>(existing?.proxy ?? "ask");
  const [gpu, setGpu] = useState<ProfileTemplate["gpu"]>(existing?.gpu ?? "keep");
  const [busy, setBusy] = useState(false);
  const gpuName = profile.gpuRenderer?.replace(/^ANGLE \([^,]*,\s*/, "").replace(/\s*(Direct3D|\(0x).*$/, "") || "Persona default";

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave({ name: name.trim(), proxy, gpu });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-w-xl" initialFocus={nameRef}>
      <DialogHeader id={titleId} title="Save as template" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-save-template="1">
        <p className="text-xs leading-relaxed text-fog/55">
          New profiles copy the settings of “{profile.name || profile.id}”. Each one gets its own new seed and empty browser data.
        </p>
        <label htmlFor={nameId} className={label + " mt-4"}>
          Template name
        </label>
        <input
          id={nameId}
          ref={nameRef}
          className={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
        <p className="mt-1 text-[11px] text-fog/40">
          {existing
            ? `Replaces the template “${existing.name}” (its use count stays).`
            : `New profiles are named ${name.trim() || "…"} 1, ${name.trim() || "…"} 2, …`}
        </p>
        <Choice
          legend="Proxy"
          value={proxy}
          onChange={setProxy}
          options={[
            { value: "ask", title: "Ask each time", sub: "time zone and language follow it" },
            { value: "keep", title: "Same proxy", sub: proxyLabel(profile.proxy) || "this profile has none" },
          ]}
        />
        <Choice
          legend="GPU"
          value={gpu}
          onChange={setGpu}
          options={[
            { value: "keep", title: "Same GPU", sub: gpuName },
            { value: "fresh", title: "New random GPU", sub: "a model from this computer's maker" },
          ]}
        />
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        <button className={btnGhost} onClick={onClose}>
          Cancel
        </button>
        <button className={btnPrimary} disabled={!name.trim() || busy} onClick={save} data-save-template-confirm="1">
          {existing ? "Replace template" : "Save template"}
        </button>
      </div>
    </Dialog>
  );
}

export function ManageTemplatesDialog({
  templates,
  onSave,
  onClose,
}: {
  templates: ProfileTemplate[];
  onSave: (next: ProfileTemplate[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [rows, setRows] = useState(templates);
  const [busy, setBusy] = useState(false);
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const clash = names.some((n, i) => !n || names.indexOf(n) !== i);
  const changed = JSON.stringify(rows) !== JSON.stringify(templates);
  const set = (id: string, patch: Partial<ProfileTemplate>) => setRows((r) => r.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  async function done() {
    if (!changed) return onClose();
    setBusy(true);
    try {
      await onSave(rows.map((t) => ({ ...t, name: t.name.trim() })));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[720px] max-w-2xl">
      <DialogHeader id={titleId} title="Templates" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-manage-templates="1">
        {rows.length === 0 ? (
          <p className="text-sm text-fog/60">
            No templates yet. Open the <span className="font-semibold text-fog">⋯</span> menu on any profile and choose{" "}
            <span className="font-semibold text-fog">Save as template</span>.
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-fog/55">
              To change a template&apos;s other settings, edit a profile and save it as a template again under the same name.
            </p>
            <ul className="flex flex-col gap-2">
              {rows.map((t) => (
                <li key={t.id} className="rounded-lg border border-line p-3" data-template-row={t.name}>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <input
                      aria-label="Template name"
                      className={input}
                      value={t.name}
                      onChange={(e) => set(t.id, { name: e.target.value })}
                    />
                    <select
                      aria-label="Proxy"
                      className={input}
                      value={t.proxy}
                      onChange={(e) => set(t.id, { proxy: e.target.value as ProfileTemplate["proxy"] })}
                      disabled={!t.base.proxy && t.proxy === "ask"}
                      title={!t.base.proxy && t.proxy === "ask" ? "Saved without a proxy, so it can only ask" : undefined}
                    >
                      <option value="ask">Ask proxy</option>
                      <option value="keep">Same proxy</option>
                    </select>
                    <select
                      aria-label="GPU"
                      className={input}
                      value={t.gpu}
                      onChange={(e) => set(t.id, { gpu: e.target.value as ProfileTemplate["gpu"] })}
                    >
                      <option value="keep">Same GPU</option>
                      <option value="fresh">New GPU</option>
                    </select>
                    <button
                      className="rounded-lg border border-danger/50 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
                      onClick={() => setRows((r) => r.filter((x) => x.id !== t.id))}
                    >
                      Delete
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-fog/40">
                    {describeTemplate(t)}
                    {t.sourceName ? ` · from “${t.sourceName}”` : ""}
                    {t.base.platform ? ` · ${t.base.platform}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            {clash && <p className="mt-2 text-xs text-warn">Every template needs its own name.</p>}
          </>
        )}
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        {changed && (
          <button className={btnGhost} onClick={onClose}>
            Cancel
          </button>
        )}
        <button className={btnPrimary} disabled={busy || clash} onClick={done} data-manage-done="1">
          {changed ? "Save changes" : "Done"}
        </button>
      </div>
    </Dialog>
  );
}
