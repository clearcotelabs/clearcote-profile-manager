"use client";

// Extensions, added once and turned on per profile (electron/extensions.ts). A profile loads the copy kept
// on this computer, so its extensions only change when someone here updates them: by hand, or before a
// launch for the ones with auto-update on. Adding from the store downloads from Google and checks the
// file's signature; the web version can do that and upload a .crx, and the desktop app can also copy in an
// unpacked folder.

import { useId, useMemo, useState } from "react";
import { t, tx } from "@/lib/i18n";
import { api, type ExtensionEntry, type ExtResult } from "@/lib/ipc";
import { displayName, relativeTime } from "@/lib/profileList";
import { useConfirm } from "./Confirm";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import type { Profile } from "@/types/profile";

const ghost = "rounded-lg border border-line px-2.5 py-1 text-[11px] font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40";
const primary = "shrink-0 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] hover:opacity-95 disabled:opacity-40";
const field =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60";

const SOURCE_LABEL: Record<ExtensionEntry["source"], string> = {
  store: "Chrome Web Store",
  crx: ".crx",
  folder: tx("Folder"),
};

const ago = (ms?: number) => (ms ? relativeTime(new Date(ms).toISOString()) : null);

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export default function ExtensionsView({
  extensions,
  profiles,
  notify,
  onProfilesChanged,
}: {
  extensions: ExtensionEntry[];
  profiles: Profile[];
  notify: (text: string, opts?: { tone?: "info" | "error" }) => void;
  /** Profiles on disk changed (turned on/off, or removed from them): reload them. */
  onProfilesChanged: () => void;
}) {
  const ext = api.extensions!;
  const confirm = useConfirm();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<ExtensionEntry | null>(null);
  const [q, setQ] = useState("");

  const usedBy = useMemo(() => {
    const m = new Map<string, Profile[]>();
    for (const p of profiles) for (const id of p.extensions ?? []) m.set(id, [...(m.get(id) ?? []), p]);
    return m;
  }, [profiles]);

  const shown = extensions.filter((e) => {
    const s = q.trim().toLowerCase();
    return !s || `${e.name} ${e.id} ${e.description ?? ""}`.toLowerCase().includes(s);
  });

  /** Run one add/update call and say how it went. */
  const run = async (key: string, fn: () => Promise<ExtResult | null>, done: (e: ExtensionEntry) => string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (!r) return false;
      if (!r.ok) {
        notify(r.error, { tone: "error" });
        return false;
      }
      notify(done(r.extension));
      return true;
    } catch (e) {
      notify(String((e as Error)?.message || e), { tone: "error" });
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addFromStore = async () => {
    if (!link.trim()) return;
    const ok = await run("store", () => ext.addStore(link.trim()), (e) => t("Added “{name}” {version}.", { name: e.name, version: e.version }));
    if (ok) setLink("");
  };

  const addCrx = async () => {
    if (ext.addCrx) {
      await run("crx", () => ext.addCrx!(), (e) => t("Added “{name}” {version}.", { name: e.name, version: e.version }));
      return;
    }
    // The web version: the browser's own file picker, and the bytes go to the helper.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".crx";
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void run("crx", async () => ext.addCrxData(await readAsBase64(f), f.name), (e) => t("Added “{name}” {version}.", { name: e.name, version: e.version }));
    };
    input.click();
  };

  const update = (e: ExtensionEntry) =>
    run(`u:${e.id}`, () => ext.update(e.id), (n) =>
      n.version !== e.version ? t("Updated “{name}” to {version}.", { name: n.name, version: n.version }) : t("“{name}” is up to date ({version}).", { name: n.name, version: n.version }),
    );

  const checkAll = async () => {
    setBusy("check");
    try {
      const r = await ext.checkAll();
      const parts: string[] = [];
      if (r.updated.length) parts.push(t("Updated: {names}.", { names: r.updated.join(", ") }));
      if (r.available.length) parts.push(t("Newer version available: {names}.", { names: r.available.join(", ") }));
      if (r.failed.length) parts.push(t("Could not check: {names}.", { names: r.failed.join(", ") }));
      notify(parts.join(" ") || t("Every store extension is up to date."), { tone: r.failed.length ? "error" : undefined });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (e: ExtensionEntry) => {
    const n = usedBy.get(e.id)?.length ?? 0;
    const ok = await confirm({
      title: t("Remove “{name}”?", { name: e.name }),
      body: n
        ? n === 1
          ? t("It is turned off in the 1 profile that uses it. What it saved in that profile stays there.")
          : t("It is turned off in the {n} profiles that use it. What it saved in those profiles stays there.", { n })
        : t("No profile uses it."),
      confirmLabel: t("Remove"),
      tone: "danger",
    });
    if (!ok) return;
    const r = await ext.remove(e.id);
    if (!r.ok) return notify(r.error ?? t("That extension is no longer here."), { tone: "error" });
    if (r.profilesChanged) onProfilesChanged();
    notify(t("Removed “{name}”.", { name: e.name }));
  };

  const setAuto = async (e: ExtensionEntry, on: boolean) => {
    const r = await ext.set(e.id, { autoUpdate: on });
    if (!r.ok) notify(r.error, { tone: "error" });
  };

  return (
    <div className="mt-5" data-extensions-page>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          void addFromStore();
        }}
      >
        <input
          id="ext-store-link"
          className={field + " max-w-md flex-1"}
          placeholder={t("Paste a Chrome Web Store link or extension ID")}
          aria-label={t("Chrome Web Store link or extension ID")}
          value={link}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" className={primary} disabled={!link.trim() || busy === "store"}>
          {busy === "store" ? t("Adding…") : t("Add from store")}
        </button>
        <button type="button" className={ghost} onClick={() => void addCrx()} disabled={busy === "crx"}>
          {t("Add .crx file…")}
        </button>
        {ext.addFolder && (
          <button
            type="button"
            className={ghost}
            onClick={() => void run("folder", () => ext.addFolder!(), (e) => t("Added “{name}” {version}.", { name: e.name, version: e.version }))}
            disabled={busy === "folder"}
          >
            {t("Add unpacked folder…")}
          </button>
        )}
        <span className="flex-1" />
        <button type="button" className={ghost} onClick={() => void checkAll()} disabled={busy === "check" || !extensions.some((e) => e.source === "store")}>
          {busy === "check" ? t("Checking…") : t("Check for updates")}
        </button>
      </form>

      {extensions.length === 0 ? (
        <div className="mt-10 text-center">
          <p className="text-base font-semibold">{t("No extensions yet")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-fog/50">
            {t("Add one from the Chrome Web Store, then turn it on for the profiles that need it. Each profile keeps its own extension data, and the version stays as it is until you update it.")}
          </p>
        </div>
      ) : (
        <>
          {extensions.length > 6 && (
            <input
              className={field + " mt-4 max-w-xs"}
              placeholder={t("Search extensions…")}
              aria-label={t("Search extensions")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface/70">
            {shown.map((e) => {
              const users = usedBy.get(e.id) ?? [];
              return (
                <li key={e.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-extension-row={e.id}>
                  {e.icon ? (
                    <img src={e.icon} alt="" className="h-8 w-8 shrink-0 rounded" />
                  ) : (
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-elevate text-xs font-semibold text-fog/50">{e.name.slice(0, 1)}</span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="truncate text-sm font-semibold">{e.name}</span>
                      <span className="font-mono text-[11px] text-fog/50">{e.version}</span>
                      <span className="rounded border border-line px-1.5 text-[10px] text-fog/50">{e.source === "folder" ? t(SOURCE_LABEL.folder) : SOURCE_LABEL[e.source]}</span>
                      {e.available && (
                        <span className="rounded bg-warn/15 px-1.5 text-[10px] font-medium text-warn">
                          {t("{version} available", { version: e.available })}
                        </span>
                      )}
                    </div>
                    {e.description && <p className="truncate text-[12px] text-fog/50">{e.description}</p>}
                    <p className="truncate font-mono text-[10px] text-fog/35" title={e.source === "folder" ? e.from : undefined}>
                      {e.id}
                      {e.source === "store" && e.checkedAt ? ` · ${t("checked {when}", { when: ago(e.checkedAt) ?? "" })}` : ""}
                    </p>
                  </div>
                  <button className={ghost} onClick={() => setAssigning(e)} aria-label={t("Choose the profiles that use {name}", { name: e.name })}>
                    {users.length === 0 ? t("Turn on for profiles…") : users.length === 1 ? t("On 1 profile") : t("On {n} profiles", { n: users.length })}
                  </button>
                  {e.source === "store" && (
                    <label className="flex items-center gap-1.5 text-[11px] text-fog/70" title={t("Before a launch, at most every 6 hours, ask the store for a newer version and install it.")}>
                      <input type="checkbox" checked={e.autoUpdate} onChange={(ev) => void setAuto(e, ev.target.checked)} />
                      {t("Auto-update")}
                    </label>
                  )}
                  {e.source !== "crx" && (
                    <button className={ghost} onClick={() => void update(e)} disabled={busy === `u:${e.id}`}>
                      {busy === `u:${e.id}` ? t("Updating…") : e.source === "folder" ? t("Reload from folder") : t("Update")}
                    </button>
                  )}
                  <button className={ghost} onClick={() => void remove(e)} aria-label={t("Remove {name}", { name: e.name })}>
                    {t("Remove")}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <p className="mt-3 max-w-2xl text-[11px] text-fog/40">
        {t("A profile runs the version kept here. With auto-update off it never changes by itself, so an update can't break a wallet or a tool mid-week. Turning an extension on or off takes effect at the profile's next launch.")}
      </p>

      {assigning && (
        <ExtensionProfilesDialog
          extension={assigning}
          profiles={profiles}
          onClose={() => setAssigning(null)}
          onSaved={(on, off) => {
            setAssigning(null);
            if (on + off) onProfilesChanged();
            notify(
              t("“{name}”: turned on for {on}, off for {off} profiles. It applies at their next launch.", { name: assigning.name, on, off }),
            );
          }}
        />
      )}
    </div>
  );
}

/** Pick the profiles an extension is on: one by one, or a whole group at once. */
export function ExtensionProfilesDialog({
  extension,
  profiles,
  onClose,
  onSaved,
}: {
  extension: ExtensionEntry;
  profiles: Profile[];
  onClose: () => void;
  onSaved: (on: number, off: number) => void;
}) {
  const titleId = useId();
  const before = useMemo(() => new Set(profiles.filter((p) => p.extensions?.includes(extension.id)).map((p) => p.id)), [profiles, extension.id]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(before));
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, Profile[]>();
    for (const p of profiles) {
      const g = p.group?.trim() || "";
      m.set(g, [...(m.get(g) ?? []), p]);
    }
    return [...m.entries()].sort(([a], [b]) => (a ? (b ? a.localeCompare(b) : -1) : 1));
  }, [profiles]);

  const match = (p: Profile) => !q.trim() || `${displayName(p)} ${p.group ?? ""} ${(p.tags ?? []).join(" ")}`.toLowerCase().includes(q.trim().toLowerCase());
  const toggle = (ids: string[], on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      for (const id of ids) {
        if (on) n.add(id);
        else n.delete(id);
      }
      return n;
    });

  const save = async () => {
    const on = [...picked].filter((id) => !before.has(id));
    const off = [...before].filter((id) => !picked.has(id));
    setSaving(true);
    try {
      const ext = api.extensions!;
      const a = on.length ? await ext.assign(extension.id, on, true) : 0;
      const b = off.length ? await ext.assign(extension.id, off, false) : 0;
      onSaved(a, b);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-w-lg max-h-[640px]">
      <DialogHeader id={titleId} title={t("Profiles that use “{name}”", { name: extension.name })} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <input className={field} placeholder={t("Search profiles…")} aria-label={t("Search profiles")} value={q} onChange={(e) => setQ(e.target.value)} />
        {profiles.length === 0 && <p className="mt-4 text-sm text-fog/50">{t("There are no profiles yet.")}</p>}
        {groups.map(([g, list]) => {
          const shown = list.filter(match);
          if (!shown.length) return null;
          const ids = shown.map((p) => p.id);
          const all = ids.every((id) => picked.has(id));
          return (
            <div key={g || "\u0000"} className="mt-3">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-fog/40">{g || t("No group")}</span>
                <button className="text-[11px] text-accent hover:underline" onClick={() => toggle(ids, !all)}>
                  {all ? t("Turn off for all {n}", { n: ids.length }) : t("Turn on for all {n}", { n: ids.length })}
                </button>
              </div>
              <ul className="mt-1">
                {shown.map((p) => (
                  <li key={p.id}>
                    <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-elevate">
                      <input type="checkbox" checked={picked.has(p.id)} onChange={(e) => toggle([p.id], e.target.checked)} />
                      <span className="truncate">{displayName(p)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
      <DialogFooter>
        <span className="text-[11px] text-fog/40">{picked.size === 1 ? t("1 profile") : t("{n} profiles", { n: picked.size })}</span>
        <span className="flex-1" />
        <button className={ghost} onClick={onClose}>
          {t("Cancel")}
        </button>
        <button className={primary} onClick={() => void save()} disabled={saving}>
          {saving ? t("Saving…") : t("Save")}
        </button>
      </DialogFooter>
    </Dialog>
  );
}
