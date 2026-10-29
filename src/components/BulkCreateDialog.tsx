"use client";

// "From proxy list…": paste proxies, get one profile each. The preview updates as you type, so
// what will be created — and which lines will not — is visible before anything is saved.

import { useId, useMemo, useRef, useState } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import { profilesFromProxyList } from "@/lib/bulkCreate";
import { applyTemplate, describeTemplate, nextNumber, type ProfileTemplate } from "@/lib/templates";
import type { HostGpuVendor } from "@/lib/gpuPicker";
import { defaultPersonaPlatform, hostOs } from "@/lib/host";
import type { Platform, Profile } from "@/types/profile";
import { t, tRich } from "@/lib/i18n";

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";

export default function BulkCreateDialog({
  existingIds,
  existingNames = [],
  groups,
  templates = [],
  hostVendor = "unknown",
  onCreate,
  onClose,
}: {
  existingIds: string[];
  /** Profile names already taken — a template's numbering continues after them. */
  existingNames?: string[];
  groups: string[];
  /** Profile templates; picking one gives every profile its settings. */
  templates?: ProfileTemplate[];
  hostVendor?: HostGpuVendor;
  onCreate: (profiles: Profile[], template?: ProfileTemplate) => Promise<void> | void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ids = { list: useId(), name: useId(), group: useId(), tags: useId(), platform: useId(), geo: useId(), groups: useId(), tpl: useId() };
  const listRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [namePattern, setNamePattern] = useState("Profile {n}");
  const [group, setGroup] = useState("");
  const [tags, setTags] = useState("");
  const [platform, setPlatform] = useState<Platform>(() => defaultPersonaPlatform(hostOs()));
  const [geoip, setGeoip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tplId, setTplId] = useState("");
  const tpl = templates.find((x) => x.id === tplId);

  /** Picking a template names the profiles after it, numbered on from the ones already there. */
  function pickTemplate(id: string) {
    setTplId(id);
    const picked = templates.find((x) => x.id === id);
    if (picked) setNamePattern(`${picked.name} {n}`);
    else setNamePattern("Profile {n}");
  }
  const startAt = tpl && namePattern.trim() === `${tpl.name} {n}` ? nextNumber(tpl, existingNames) : undefined;
  // With a template: its settings under each listed profile's own name, seed and proxy.
  const build = (list: Profile[]) => (tpl ? list.map((p) => applyTemplate(p, tpl, { hostVendor })) : list);

  // Suffix and seed are stable per render so the preview names don't flicker; the real ids are
  // generated again on create.
  const preview = useMemo(
    () =>
      profilesFromProxyList(text, { namePattern, group, tags: tags.split(","), platform, geoip, startAt }, existingIds, {
        seed: () => "preview",
        suffix: () => "xxxx",
      }),
    [text, namePattern, group, tags, platform, geoip, existingIds, startAt],
  );

  async function create() {
    const real = profilesFromProxyList(text, { namePattern, group, tags: tags.split(","), platform, geoip, startAt }, existingIds);
    if (!real.profiles.length) return;
    setBusy(true);
    try {
      await onCreate(build(real.profiles), tpl);
    } finally {
      setBusy(false);
    }
  }

  const n = preview.profiles.length;
  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[720px] max-w-2xl" initialFocus={listRef}>
      <DialogHeader id={titleId} title={t("Create profiles from a proxy list")} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {templates.length > 0 && (
          <div className="mb-4">
            <label htmlFor={ids.tpl} className={label}>
              {t("Template")}
            </label>
            <select id={ids.tpl} className={input} value={tplId} onChange={(e) => pickTemplate(e.target.value)} data-bulk-template="1">
              <option value="">{t("None — default settings")}</option>
              {templates.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {t(describeTemplate({ ...x, usedCount: 0 }))}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-fog/40">
              {tpl
                ? t("Every profile copies the template's settings with its own seed and the proxy from its line. Group and tags below override the template's.")
                : t("Pick one to give every profile the settings of a template.")}
            </p>
          </div>
        )}
        <label htmlFor={ids.list} className={label}>
          {t("Proxies — one per line")}
        </label>
        <textarea
          id={ids.list}
          ref={listRef}
          className={input + " min-h-[140px] resize-y font-mono text-xs"}
          placeholder={"http://user:pass@de1.example.net:8080\nsocks5://user:pass@10.0.0.1:1080\n203.0.113.7:3128:user:pass"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
        />
        <p className="mt-1 text-[11px] text-fog/40">
          {tRich(
            "Also accepts {f1}, {f2} and {f3}, with a scheme like socks5:// in front or without (then http). Blank lines and lines starting with # are skipped.",
            {
              f1: <span className="font-mono">host:port:user:pass</span>,
              f2: <span className="font-mono">user:pass:host:port</span>,
              f3: <span className="font-mono">host:port@user:pass</span>,
            },
          )}
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.name} className={label}>
              {t("Names")}
            </label>
            <input id={ids.name} className={input} value={namePattern} onChange={(e) => setNamePattern(e.target.value)} />
            <p className="mt-1 text-[11px] text-fog/40">
              {tRich("{num} numbers them, {hostvar} is the proxy host.", {
                num: <span className="font-mono">{"{n}"}</span>,
                hostvar: <span className="font-mono">{"{host}"}</span>,
              })}
            </p>
          </div>
          <div>
            <label htmlFor={ids.group} className={label}>
              {t("Group")}
            </label>
            <input
              id={ids.group}
              className={input}
              value={group}
              list={groups.length ? ids.groups : undefined}
              onChange={(e) => setGroup(e.target.value)}
              placeholder={t("optional")}
            />
            {groups.length > 0 && (
              <datalist id={ids.groups}>
                {groups.map((g) => (
                  <option key={g} value={g} />
                ))}
              </datalist>
            )}
          </div>
          <div>
            <label htmlFor={ids.tags} className={label}>
              {t("Tags")}
            </label>
            <input id={ids.tags} className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("comma, separated")} />
          </div>
          <div>
            <label htmlFor={ids.platform} className={label}>
              {t("Platform")}
            </label>
            <select
              id={ids.platform}
              className={input + (tpl ? " opacity-40" : "")}
              value={tpl?.base.platform ?? platform}
              disabled={!!tpl}
              title={tpl ? t("From the template") : undefined}
              onChange={(e) => setPlatform(e.target.value as Platform)}
            >
              <option value="windows">Windows</option>
              <option value="linux">Linux</option>
              <option value="macos">macOS</option>
              <option value="android">Android</option>
            </select>
          </div>
        </div>
        <label htmlFor={ids.geo} className="mt-3 flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80">
          <input id={ids.geo} type="checkbox" className="mt-0.5 accent-[#38e0d6]" checked={geoip} onChange={(e) => setGeoip(e.target.checked)} />
          <span>
            {tRich(
              "<b>Match each proxy's location</b> — timezone, language and position follow the proxy's exit region at launch.",
              { b: (s) => <span className="font-medium text-fog">{s}</span> },
            )}
          </span>
        </label>

        <div className="mt-4" aria-live="polite">
          <div className="text-[11px] font-medium uppercase tracking-wide text-fog/45">{t("Preview")}</div>
          {n === 0 && preview.invalid.length === 0 ? (
            <p className="mt-1 text-xs text-fog/40">{t("Paste some proxies to see what will be created.")}</p>
          ) : (
            <div className="mt-1 rounded-lg border border-line text-xs">
              <p className="border-b border-line px-3 py-2 text-fog/70">
                {n === 1
                  ? tRich("{count} profile will be created", { count: <span className="font-semibold text-fog">{n}</span> })
                  : tRich("{count} profiles will be created", { count: <span className="font-semibold text-fog">{n}</span> })}
                {preview.duplicates
                  ? " · " +
                    (preview.duplicates === 1
                      ? t("1 duplicate skipped")
                      : t("{n} duplicates skipped", { n: preview.duplicates }))
                  : ""}
                {preview.invalid.length
                  ? " · " +
                    (preview.invalid.length === 1
                      ? t("1 line not understood")
                      : t("{n} lines not understood", { n: preview.invalid.length }))
                  : ""}
              </p>
              <ul className="max-h-40 overflow-y-auto px-3 py-2">
                {preview.profiles.slice(0, 50).map((p) => (
                  <li key={p.name} className="flex gap-3 py-0.5">
                    <span className="w-40 shrink-0 truncate text-fog/80">{p.name}</span>
                    <span className="truncate font-mono text-fog/40">{p.proxy?.replace(/\/\/[^@/]*@/, "//")}</span>
                  </li>
                ))}
                {preview.profiles.length > 50 && <li className="py-0.5 text-fog/40">{t("… and {n} more", { n: preview.profiles.length - 50 })}</li>}
                {preview.invalid.map((l) => (
                  <li key={`bad-${l.line}`} className="py-0.5 text-warn">
                    {tRich("Line {line} is not a proxy address: {text}", {
                      line: l.line,
                      text: <span className="font-mono">{l.text.slice(0, 60)}</span>,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        <button className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={onClose}>
          {t("Cancel")}
        </button>
        <button
          className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40"
          disabled={n === 0 || busy}
          onClick={create}
        >
          {busy ? t("Creating…") : n ? (n === 1 ? t("Create 1 profile") : t("Create {n} profiles", { n })) : t("Create")}
        </button>
      </div>
    </Dialog>
  );
}
