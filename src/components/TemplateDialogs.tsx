"use client";

// Profile templates: "Save as template" (from a card's ⋯ menu) and "Manage templates" (from the New
// profile menu). What a template copies and what it makes fresh is decided in src/lib/templates.ts.

import { useId, useRef, useState } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import { describeTemplate, findTemplateByName, suggestTemplateName, type ProfileTemplate } from "@/lib/templates";
import type { Profile } from "@/types/profile";
import { t, tRich } from "@/lib/i18n";

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
  const gpuName = profile.gpuRenderer?.replace(/^ANGLE \([^,]*,\s*/, "").replace(/\s*(Direct3D|\(0x).*$/, "") || t("Persona default");

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
      <DialogHeader id={titleId} title={t("Save as template")} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-save-template="1">
        <p className="text-xs leading-relaxed text-fog/55">
          {t("New profiles copy the settings of “{name}”. Each one gets its own new seed and empty browser data.", {
            name: profile.name || profile.id,
          })}
        </p>
        <label htmlFor={nameId} className={label + " mt-4"}>
          {t("Template name")}
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
            ? t("Replaces the template “{name}” (its use count stays).", { name: existing.name })
            : t("New profiles are named {name} 1, {name} 2, …", { name: name.trim() || "…" })}
        </p>
        <Choice
          legend={t("Proxy")}
          value={proxy}
          onChange={setProxy}
          options={[
            { value: "ask", title: t("Ask each time"), sub: t("time zone and language follow it") },
            { value: "keep", title: t("Same proxy"), sub: proxyLabel(profile.proxy) || t("this profile has none") },
          ]}
        />
        <Choice
          legend="GPU"
          value={gpu}
          onChange={setGpu}
          options={[
            { value: "keep", title: t("Same GPU"), sub: gpuName },
            { value: "fresh", title: t("New random GPU"), sub: t("a model from this computer's maker") },
          ]}
        />
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        <button className={btnGhost} onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className={btnPrimary} disabled={!name.trim() || busy} onClick={save} data-save-template-confirm="1">
          {existing ? t("Replace template") : t("Save template")}
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
  const set = (id: string, patch: Partial<ProfileTemplate>) => setRows((r) => r.map((tpl) => (tpl.id === id ? { ...tpl, ...patch } : tpl)));

  async function done() {
    if (!changed) return onClose();
    setBusy(true);
    try {
      await onSave(rows.map((tpl) => ({ ...tpl, name: tpl.name.trim() })));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[720px] max-w-2xl">
      <DialogHeader id={titleId} title={t("Templates")} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-manage-templates="1">
        {rows.length === 0 ? (
          <p className="text-sm text-fog/60">
            {tRich("No templates yet. Open the <b>⋯</b> menu on any profile and choose <b>Save as template</b>.", {
              b: (s) => <span className="font-semibold text-fog">{s}</span>,
            })}
          </p>
        ) : (
          <>
            <p className="mb-3 text-xs text-fog/55">
              {t("To change a template's other settings, edit a profile and save it as a template again under the same name.")}
            </p>
            <ul className="flex flex-col gap-2">
              {rows.map((tpl) => (
                <li key={tpl.id} className="rounded-lg border border-line p-3" data-template-row={tpl.name}>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <input
                      aria-label={t("Template name")}
                      className={input}
                      value={tpl.name}
                      onChange={(e) => set(tpl.id, { name: e.target.value })}
                    />
                    <select
                      aria-label={t("Proxy")}
                      className={input}
                      value={tpl.proxy}
                      onChange={(e) => set(tpl.id, { proxy: e.target.value as ProfileTemplate["proxy"] })}
                      disabled={!tpl.base.proxy && tpl.proxy === "ask"}
                      title={!tpl.base.proxy && tpl.proxy === "ask" ? t("Saved without a proxy, so it can only ask") : undefined}
                    >
                      <option value="ask">{t("Ask proxy")}</option>
                      <option value="keep">{t("Same proxy")}</option>
                    </select>
                    <select
                      aria-label="GPU"
                      className={input}
                      value={tpl.gpu}
                      onChange={(e) => set(tpl.id, { gpu: e.target.value as ProfileTemplate["gpu"] })}
                    >
                      <option value="keep">{t("Same GPU")}</option>
                      <option value="fresh">{t("New GPU")}</option>
                    </select>
                    <button
                      className="rounded-lg border border-danger/50 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
                      onClick={() => setRows((r) => r.filter((x) => x.id !== tpl.id))}
                    >
                      {t("Delete")}
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] text-fog/40">
                    {t(describeTemplate(tpl))}
                    {tpl.sourceName ? " · " + t("from “{name}”", { name: tpl.sourceName }) : ""}
                    {tpl.base.platform ? ` · ${tpl.base.platform}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            {clash && <p className="mt-2 text-xs text-warn">{t("Every template needs its own name.")}</p>}
          </>
        )}
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        {changed && (
          <button className={btnGhost} onClick={onClose}>
            {t("Cancel")}
          </button>
        )}
        <button className={btnPrimary} disabled={busy || clash} onClick={done} data-manage-done="1">
          {changed ? t("Save changes") : t("Done")}
        </button>
      </div>
    </Dialog>
  );
}
