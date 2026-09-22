"use client";

// "From proxy list…": paste proxies, get one profile each. The preview updates as you type, so
// what will be created — and which lines will not — is visible before anything is saved.

import { useId, useMemo, useRef, useState } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import { profilesFromProxyList } from "@/lib/bulkCreate";
import type { Platform, Profile } from "@/types/profile";

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog outline-none placeholder:text-fog/30 focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const label = "block text-[11px] font-medium uppercase tracking-wide text-fog/45 mb-1";

export default function BulkCreateDialog({
  existingIds,
  groups,
  onCreate,
  onClose,
}: {
  existingIds: string[];
  groups: string[];
  onCreate: (profiles: Profile[]) => Promise<void> | void;
  onClose: () => void;
}) {
  const titleId = useId();
  const ids = { list: useId(), name: useId(), group: useId(), tags: useId(), platform: useId(), geo: useId(), groups: useId() };
  const listRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [namePattern, setNamePattern] = useState("Profile {n}");
  const [group, setGroup] = useState("");
  const [tags, setTags] = useState("");
  const [platform, setPlatform] = useState<Platform>("windows");
  const [geoip, setGeoip] = useState(true);
  const [busy, setBusy] = useState(false);

  // Suffix and seed are stable per render so the preview names don't flicker; the real ids are
  // generated again on create.
  const preview = useMemo(
    () =>
      profilesFromProxyList(text, { namePattern, group, tags: tags.split(","), platform, geoip }, existingIds, {
        seed: () => "preview",
        suffix: () => "xxxx",
      }),
    [text, namePattern, group, tags, platform, geoip, existingIds],
  );

  async function create() {
    const real = profilesFromProxyList(text, { namePattern, group, tags: tags.split(","), platform, geoip }, existingIds);
    if (!real.profiles.length) return;
    setBusy(true);
    try {
      await onCreate(real.profiles);
    } finally {
      setBusy(false);
    }
  }

  const n = preview.profiles.length;
  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[720px] max-w-2xl" initialFocus={listRef}>
      <DialogHeader id={titleId} title="Create profiles from a proxy list" onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <label htmlFor={ids.list} className={label}>
          Proxies — one per line
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
          Also accepts <span className="font-mono">host:port:user:pass</span>, the format most providers export. Blank lines and
          lines starting with # are skipped.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.name} className={label}>
              Names
            </label>
            <input id={ids.name} className={input} value={namePattern} onChange={(e) => setNamePattern(e.target.value)} />
            <p className="mt-1 text-[11px] text-fog/40">
              <span className="font-mono">{"{n}"}</span> numbers them, <span className="font-mono">{"{host}"}</span> is the proxy host.
            </p>
          </div>
          <div>
            <label htmlFor={ids.group} className={label}>
              Group
            </label>
            <input
              id={ids.group}
              className={input}
              value={group}
              list={groups.length ? ids.groups : undefined}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="optional"
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
              Tags
            </label>
            <input id={ids.tags} className={input} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated" />
          </div>
          <div>
            <label htmlFor={ids.platform} className={label}>
              Platform
            </label>
            <select id={ids.platform} className={input} value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
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
            <span className="font-medium text-fog">Match each proxy's location</span> — timezone, language and position follow the
            proxy's exit region at launch.
          </span>
        </label>

        <div className="mt-4" aria-live="polite">
          <div className="text-[11px] font-medium uppercase tracking-wide text-fog/45">Preview</div>
          {n === 0 && preview.invalid.length === 0 ? (
            <p className="mt-1 text-xs text-fog/40">Paste some proxies to see what will be created.</p>
          ) : (
            <div className="mt-1 rounded-lg border border-line text-xs">
              <p className="border-b border-line px-3 py-2 text-fog/70">
                <span className="font-semibold text-fog">{n}</span> profile{n === 1 ? "" : "s"} will be created
                {preview.duplicates ? ` · ${preview.duplicates} duplicate${preview.duplicates === 1 ? "" : "s"} skipped` : ""}
                {preview.invalid.length ? ` · ${preview.invalid.length} line${preview.invalid.length === 1 ? "" : "s"} not understood` : ""}
              </p>
              <ul className="max-h-40 overflow-y-auto px-3 py-2">
                {preview.profiles.slice(0, 50).map((p) => (
                  <li key={p.name} className="flex gap-3 py-0.5">
                    <span className="w-40 shrink-0 truncate text-fog/80">{p.name}</span>
                    <span className="truncate font-mono text-fog/40">{p.proxy?.replace(/\/\/[^@/]*@/, "//")}</span>
                  </li>
                ))}
                {preview.profiles.length > 50 && <li className="py-0.5 text-fog/40">… and {preview.profiles.length - 50} more</li>}
                {preview.invalid.map((l) => (
                  <li key={`bad-${l.line}`} className="py-0.5 text-warn">
                    Line {l.line} is not a proxy address: <span className="font-mono">{l.text.slice(0, 60)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-none items-center justify-end gap-2 border-t border-line bg-ink/40 px-5 py-2.5">
        <button className="rounded-lg border border-line-strong px-3.5 py-1.5 text-sm text-fog/80 hover:bg-elevate" onClick={onClose}>
          Cancel
        </button>
        <button
          className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40"
          disabled={n === 0 || busy}
          onClick={create}
        >
          {busy ? "Creating…" : n ? `Create ${n} profile${n === 1 ? "" : "s"}` : "Create"}
        </button>
      </div>
    </Dialog>
  );
}
