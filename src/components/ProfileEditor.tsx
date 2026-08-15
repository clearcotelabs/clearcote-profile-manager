"use client";

// The profile editor: a category rail, one panel at a time, and a coherence view.
//
// Replaces a single 35-control scroll in which `Name` was styled exactly like `Canvas bridge cache
// miss`, nine paragraphs of reference prose sat permanently between the fields, and Save was only
// reachable from the bottom. The fields themselves are unchanged — they come from src/lib/fields.ts,
// so adding an engine switch is one schema entry rather than JSX appended to whichever section was
// nearest.
//
// Three things this buys that the old form could not:
//   - a badge per category counting what YOU set, which answers "what did I touch?" when a profile
//     misbehaves;
//   - a search box, which is just a filter over the schema;
//   - coherence issues that DEEP-LINK to the field that caused them, which is what makes splitting
//     settings across six panels safe rather than a hiding place.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CATEGORIES,
  FIELDS,
  countSet,
  fieldByKey,
  fieldsIn,
  isFieldSet,
  searchFields,
  type CategoryId,
  type FieldDef,
} from "@/lib/fields";
import { coherenceIssues, coherenceSummary, shouldAutoEnableGeoip, type Issue } from "@/lib/coherence";
import {
  profileToArgs,
  profileToEnv,
  proxyString,
  MIN_PROFILE_SCREEN_WIDTH,
  MIN_PROFILE_SCREEN_HEIGHT,
  type FingerprintMeta,
  type Profile,
} from "@/types/profile";
import { api, type GeoResult, type VersionOption } from "@/lib/ipc";

const input =
  "w-full rounded-lg border border-line bg-ink/60 px-3 py-1.5 text-sm text-fog outline-none placeholder:text-fog/25 focus:border-accent/60";
const label = "mb-1 block text-[10px] font-medium uppercase tracking-wider text-fog/40";
const btnGhost = "rounded-lg border border-line px-3 py-1.5 text-sm text-fog/70 hover:border-line-strong hover:text-fog";

const randomSeed = () => Math.random().toString(36).slice(2, 14);

/** The host OS, for the coherence rules that only fire off-Windows (the shader dialect). The
 *  renderer has a real navigator, so this needs no extra IPC. */
function hostPlatform(): "windows" | "linux" | "macos" | undefined {
  if (typeof navigator === "undefined") return undefined;
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macos";
  if (p.includes("linux") || p.includes("x11")) return "linux";
  return undefined;
}

/** The major a profile's version selection resolves to, or undefined when it cannot be known.
 *  "latest" depends on licence tier, which the editor does not know, so it stays undefined and the
 *  version-gated rules keep quiet rather than guessing — the same discipline the launcher uses for
 *  an explicit binary. */
function selectedMajor(v: string | undefined): number | undefined {
  const raw = (v ?? "").trim().toLowerCase();
  if (!raw || raw === "latest" || raw === "auto") return undefined;
  const m = /^(\d+)/.exec(raw);
  return m ? Number(m[1]) : undefined;
}

export interface ProfileEditorProps {
  profile: Profile;
  onChange: (p: Profile) => void;
  onSave: (p: Profile) => void;
  onCancel: () => void;
  /** Rendered above the panel when the library picker is open. */
  renderLibrary?: (onApply: (file: string, meta?: FingerprintMeta) => void, onClose: () => void) => React.ReactNode;
}

export default function ProfileEditor({ profile, onChange, onSave, onCancel, renderLibrary }: ProfileEditorProps) {
  const [cat, setCat] = useState<CategoryId>("identity");
  const [query, setQuery] = useState("");
  const [cohOpen, setCohOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);

  // Carried over verbatim from the previous editor.
  const [geo, setGeo] = useState<GeoResult | null>(null);
  const [resolving, setResolving] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [fpMsg, setFpMsg] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [revisions, setRevisions] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  /** Set when we turned geoip on for the user, so the editor can say so rather than
   *  silently changing a setting they did not touch. */
  const [autoGeoip, setAutoGeoip] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);

  // One load on mount. The `alive` flag stops a late resolve from setting state after unmount, and
  // the optional calls tolerate an older preload that predates these channels.
  useEffect(() => {
    let alive = true;
    api.listVersions?.().then((v) => alive && setVersions(v || [])).catch(() => {});
    api.listRevisions?.().then((r) => alive && setRevisions(r || [])).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const set = useCallback(
    <K extends keyof Profile>(k: K, v: Profile[K]) => onChange({ ...profile, [k]: v }),
    [profile, onChange],
  );

  const issues = useMemo(
    () =>
      coherenceIssues(profile as unknown as Record<string, unknown>, {
        major: selectedMajor(profile.browserVersion),
        hostPlatform: hostPlatform(),
        capturedScreenWarning: profile.fingerprintProfileMeta?.screenWarning,
      }),
    [profile],
  );
  const summary = coherenceSummary(issues);

  /** Jump to the field an issue blames: switch category, clear the search, scroll and flash it. */
  const goTo = useCallback((key: string) => {
    const f = fieldByKey(key);
    if (!f) return;
    setQuery("");
    setCat(f.cat);
    setFlash(key);
    window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input,select,textarea,button")?.focus({ preventScroll: true });
    }, 0);
    window.setTimeout(() => setFlash(null), 1800);
  }, []);

  async function importFp() {
    setFpMsg(null);
    const r = await api.fp.import();
    if (r.ok && r.file) onChange({ ...profile, fingerprintProfile: r.file, fingerprintProfileMeta: r.meta });
    else if (r.error) setFpMsg(r.error);
  }

  function applyLibrary(file: string, meta?: FingerprintMeta) {
    onChange({ ...profile, fingerprintProfile: file, fingerprintProfileMeta: meta });
    setLibOpen(false);
    setFpMsg(null);
  }

  async function resolveGeo() {
    setResolving(true);
    try {
      const r = await api.geoCheck(profile);
      setGeo(r);
      if (r.ok) {
        // Every field falls back to what is already there, so a blank response never clobbers a
        // value the user chose.
        onChange({
          ...profile,
          timezone: r.timezone || profile.timezone,
          acceptLanguage: r.acceptLanguage || profile.acceptLanguage,
          location: r.lat != null && r.lon != null ? `${r.lat},${r.lon}` : profile.location,
          webrtcIp: r.ip || profile.webrtcIp,
        });
      }
    } finally {
      // try/finally so a throw cannot strand the button in its resolving state.
      setResolving(false);
    }
  }

  const args = profileToArgs({ ...profile, userDataDir: profile.userDataDir || `profiles/${profile.id || "<id>"}/userdata` });
  const envLines = Object.entries(profileToEnv(profile))
    .map(([k, v]) => `${k}=${v} \\\n`)
    .join("");

  const results = query.trim() ? searchFields(query) : null;
  const shown = (results ?? fieldsIn(cat)).filter((f) => !f.showWhen || f.showWhen(profile as unknown as Record<string, unknown>));

  // ── Field rendering ────────────────────────────────────────────────────────
  function why(f: FieldDef) {
    if (!f.why) return null;
    return (
      <button
        type="button"
        title={f.why}
        aria-label={`Why: ${f.label}`}
        className="ml-1 h-[13px] w-[13px] shrink-0 rounded-full border border-line text-[9px] leading-none text-fog/40 hover:border-accent hover:text-accent"
      >
        ?
      </button>
    );
  }

  function labelFor(f: FieldDef) {
    return (
      <span className={label + " flex items-center gap-1.5"}>
        {isFieldSet(profile as unknown as Record<string, unknown>, f) && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-iris" title="You set this" />
        )}
        {f.label}
        {why(f)}
      </span>
    );
  }

  function textValue(f: FieldDef): string {
    const v = (profile as unknown as Record<string, unknown>)[f.key];
    return v == null || typeof v === "boolean" ? "" : String(v);
  }

  function storeText(f: FieldDef, raw: string) {
    // `name` keeps a raw string (it is the one field an empty value is still meaningful for, as the
    // save button and the title read it); everything else drops the key when emptied.
    set(f.key as keyof Profile, (f.key === "name" ? raw : raw || undefined) as never);
  }

  function renderPlain(f: FieldDef) {
    const disabled = !!(f.disabledBy && (profile as unknown as Record<string, unknown>)[f.disabledBy]);
    const cls = input + (f.mono ? " font-mono" : "") + (disabled ? " opacity-40" : "");

    if (f.type === "check") {
      const raw = (profile as unknown as Record<string, unknown>)[f.key];
      const on = f.defaultOn ? raw !== false : f.onValue === "hlsl" ? raw === "hlsl" : !!raw;
      return (
        <label className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 text-sm text-fog/80">
          <input
            type="checkbox"
            className="mt-0.5 accent-[#38e0d6]"
            checked={on}
            disabled={disabled}
            onChange={(e) =>
              set(
                f.key as keyof Profile,
                (e.target.checked ? (f.onValue ?? true) : (f.offValue ?? undefined)) as never,
              )
            }
          />
          <span>
            <span className="font-medium text-fog">{f.label}</span>
            {f.desc ? <> — {f.desc}</> : null}
            {f.why ? why(f) : null}
            {f.hint ? <span className="mt-1 block text-[11px] text-fog/40">{f.hint}</span> : null}
          </span>
        </label>
      );
    }

    if (f.type === "select") {
      const cur = textValue(f);
      return (
        <>
          {labelFor(f)}
          <select
            className={cls}
            value={cur || f.defaultOption || (f.options?.[0]?.value ?? "")}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              const store = f.defaultOption !== undefined && v === f.defaultOption ? undefined : v;
              set(f.key as keyof Profile, store as never);
            }}
          >
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{f.hint}</p> : null}
        </>
      );
    }

    if (f.type === "textarea") {
      return (
        <>
          {labelFor(f)}
          <textarea
            className={cls + " min-h-[60px] resize-y"}
            value={textValue(f)}
            placeholder={f.placeholder}
            onChange={(e) => storeText(f, e.target.value)}
          />
        </>
      );
    }

    if (f.type === "number") {
      return (
        <>
          {labelFor(f)}
          <input
            className={cls}
            type="number"
            step={f.stepAny ? "any" : undefined}
            value={textValue(f)}
            placeholder={f.placeholder}
            disabled={disabled}
            // Compared against "" rather than tested for truthiness, so a real 0 survives —
            // maxTouchPoints: 0 is a mouse-only desktop, not an empty field.
            onChange={(e) => set(f.key as keyof Profile, (e.target.value === "" ? undefined : Number(e.target.value)) as never)}
          />
          {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{f.hint}</p> : null}
        </>
      );
    }

    return (
      <>
        {labelFor(f)}
        <input
          className={cls}
          type={f.type === "password" ? "password" : "text"}
          autoComplete={f.type === "password" ? "off" : undefined}
          value={textValue(f)}
          placeholder={f.placeholder}
          disabled={disabled}
          onChange={(e) => storeText(f, e.target.value)}
        />
        {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{f.hint}</p> : null}
      </>
    );
  }

  function renderCustom(f: FieldDef) {
    switch (f.custom) {
      case "seed":
        return (
          <>
            {labelFor(f)}
            <div className="flex gap-2">
              <input
                className={input + " font-mono"}
                value={profile.fingerprint}
                onChange={(e) => set("fingerprint", e.target.value)}
              />
              <button className={btnGhost} onClick={() => set("fingerprint", randomSeed())} title="Randomize">
                ↻
              </button>
            </div>
          </>
        );

      case "tags":
        return (
          <>
            {labelFor(f)}
            <input
              className={input}
              value={(profile.tags || []).join(", ")}
              placeholder={f.placeholder}
              onChange={(e) => set("tags", e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
            />
          </>
        );

      case "canvasBridgeAllow":
      case "canvasBridgeDeny": {
        const key = f.custom === "canvasBridgeAllow" ? "canvasBridgeAllow" : "canvasBridgeDeny";
        const list = (profile[key] as string[] | undefined) || [];
        return (
          <>
            {labelFor(f)}
            <input
              className={input + " font-mono"}
              value={list.join(", ")}
              placeholder={f.placeholder}
              onChange={(e) => {
                const v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                set(key, (v.length ? v : undefined) as never);
              }}
            />
          </>
        );
      }

      case "extraArgs":
        return (
          <>
            {labelFor(f)}
            <textarea
              className={input + " min-h-[56px] resize-y font-mono"}
              value={(profile.extraArgs || []).join("\n")}
              placeholder={"--one-flag-per-line\n--window-size=1280,800"}
              // One per line, not space-separated: a switch value can legitimately contain a space,
              // and splitting on whitespace would quietly cut it in half.
              onChange={(e) => {
                const v = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                set("extraArgs", (v.length ? v : undefined) as never);
              }}
            />
            <p className="mt-1 text-[11px] text-fog/40">One flag per line. Appended verbatim, after everything else.</p>
          </>
        );

      case "browserVersion": {
        const pinned = /-r\d+$/.test(profile.browserVersion || "");
        const orphan = pinned && !revisions.includes(profile.browserVersion || "");
        return (
          <>
            {labelFor(f)}
            <select
              className={input}
              value={profile.browserVersion || "latest"}
              onChange={(e) => set("browserVersion", e.target.value === "latest" ? undefined : e.target.value)}
            >
              <option value="latest">Latest (recommended)</option>
              {versions.map((v) => (
                <option key={v.version} value={String(v.major)}>
                  {v.major} · {v.tier === "pro" ? "Pro" : "Free"} ({v.version})
                </option>
              ))}
              {revisions.length > 0 && (
                <optgroup label="Pin an exact Pro rebuild">
                  {revisions.map((r, i) => (
                    <option key={r} value={r}>
                      {r}
                      {i === 0 ? " · current" : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {/* A pin that is no longer published must not silently read as "Latest". */}
              {orphan && <option value={profile.browserVersion}>{profile.browserVersion} · pinned</option>}
            </select>
            <p className="mt-1 text-[11px] text-fog/40">
              Latest is the newest of your tier. A Pro build needs a license key in Settings.
              {revisions.length > 0
                ? " Latest and a bare major both follow the current Pro pin, which moves when a rebuild ships — pin a revision for reproducible runs."
                : ""}
            </p>
          </>
        );
      }

      case "proxy":
        return (
          <>
            <div className="flex items-center justify-between">
              {labelFor(f)}
              {profile.proxy && (
                <button className={btnGhost + " -mt-1 py-1 text-xs"} onClick={resolveGeo} disabled={resolving}>
                  {resolving ? "Resolving…" : "Resolve from proxy →"}
                </button>
              )}
            </div>
            <input
              className={input + " font-mono"}
              value={proxyString(profile.proxy)}
              placeholder="http://user:pass@host:8080  ·  socks5://user:pass@host:1080"
              onChange={(e) => {
                const next = e.target.value || undefined;
                // Auto-correct, once: the moment a profile FIRST gains a proxy, turn geoip on so the
                // persona's region follows the exit rather than the host. Fired on the transition —
                // not on every keystroke — so unticking geoip afterwards sticks instead of being
                // switched back on under the user. Legacy profiles that arrive already incoherent
                // are handled by the coherence warning instead, since silently rewriting a saved
                // profile on open is not ours to do.
                if (shouldAutoEnableGeoip(profile, next)) {
                  onChange({ ...profile, proxy: next, geoip: true });
                  setAutoGeoip(true);
                  return;
                }
                if (!next) setAutoGeoip(false);
                set("proxy", next);
              }}
            />
            {autoGeoip && profile.geoip && (
              <p className="mt-1 text-[11px] text-accent">
                geoip switched on — timezone, language and position will follow this proxy&apos;s exit region at
                launch. Untick it below if you don&apos;t want that.
              </p>
            )}
            {geo && (
              <p className={"mt-1 text-[11px] " + (geo.ok ? "text-accent" : "text-amber-500")}>
                {geo.ok
                  ? `egress ${geo.ip} · ${geo.country ?? "?"} · ${geo.timezone ?? "?"} · ${geo.acceptLanguage ?? "?"}`
                  : geo.error}
              </p>
            )}
          </>
        );

      case "fingerprintProfile": {
        const meta = profile.fingerprintProfileMeta;
        return (
          <>
            <div className="flex items-center justify-between">
              {labelFor(f)}
              {profile.fingerprintProfile && (
                <button
                  className={btnGhost + " -mt-1 py-1 text-xs"}
                  onClick={() => onChange({ ...profile, fingerprintProfile: undefined, fingerprintProfileMeta: undefined })}
                >
                  Clear
                </button>
              )}
            </div>
            <div className="rounded-lg border border-line p-3">
              {profile.fingerprintProfile ? (
                <>
                  <div className="flex items-center gap-2 text-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                    <span className="font-medium">
                      {meta?.label || profile.fingerprintProfile}
                      {meta?.source === "library" ? " · library" : ""}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-fog/50">{meta?.renderer || "captured profile"}</p>
                  <p className="mt-0.5 text-[11px] text-fog/40">
                    {[meta?.cores ? `${meta.cores} cores` : null, meta?.memory ? `${meta.memory} GB` : null, meta?.screen]
                      .filter(Boolean)
                      .join("  ·  ")}
                  </p>
                  {meta?.screenWarning && (
                    <p className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-400">
                      ⚠ {meta.screenWarning}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-[11px] text-fog/40">
                  Load a real machine&apos;s GPU, screen, fonts, voices and WebGL. Its values override the seed persona.
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button className={btnGhost + " py-1 text-xs"} onClick={importFp}>
                  Import from file…
                </button>
                <button className={btnGhost + " py-1 text-xs"} onClick={() => setLibOpen(true)}>
                  Browse library…
                </button>
              </div>
              {fpMsg && <p className="mt-2 text-[11px] text-amber-500">{fpMsg}</p>}
            </div>
          </>
        );
      }

      default:
        return null;
    }
  }

  function renderField(f: FieldDef) {
    const flashing = flash === f.key;
    return (
      <div
        key={f.key}
        data-field={f.key}
        className={
          (f.full || f.type === "check" ? "sm:col-span-2 " : "") +
          "rounded-lg transition-shadow " +
          (flashing ? "shadow-[0_0_0_4px_rgba(245,158,11,.25)]" : "")
        }
      >
        {f.type === "custom" ? renderCustom(f) : renderPlain(f)}
      </div>
    );
  }

  /** Render a category's fields, wrapping any grouped run in its own bordered sub-panel. */
  function renderFields(list: FieldDef[]) {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (!f.group) {
        out.push(renderField(f));
        continue;
      }
      const members: FieldDef[] = [];
      const groupName = f.group;
      const note = f.groupNote;
      while (i < list.length && list[i].group === groupName) members.push(list[i++]);
      i--;
      out.push(
        <div key={"g-" + groupName} className="sm:col-span-2 rounded-lg border border-line/70 bg-ink/30 p-3">
          <p className="text-[10px] font-medium uppercase tracking-wider text-fog/40">{groupName}</p>
          {note && <p className="mb-3 mt-1 text-[11px] text-fog/40">{note}</p>}
          <div className={"grid grid-cols-1 gap-3 sm:grid-cols-2 " + (note ? "" : "mt-3")}>
            {members.map((m) => renderField(m))}
          </div>
        </div>,
      );
    }
    return out;
  }

  const category = CATEGORIES.find((c) => c.id === cat)!;

  return (
    <>
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm sm:p-6">
        <div className="flex h-full max-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
          {/* Header — pinned, so Save is never a scroll away. */}
          <div className="flex flex-none items-center gap-3 border-b border-line px-5 py-3">
            <h2 className="text-base font-semibold">{profile.id ? "Edit profile" : "New profile"}</h2>
            <span className="truncate text-sm text-fog/40">{profile.name || "Untitled"}</span>
            <span className="flex-1" />
            <button
              onClick={() => setCohOpen((v) => !v)}
              aria-expanded={cohOpen}
              className={
                "rounded-full border px-3 py-1 text-xs " +
                (summary.ok
                  ? "border-accent/40 text-accent"
                  : summary.errors
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-400")
              }
            >
              {summary.ok
                ? "✓ coherent"
                : `▲ ${issues.length} ${issues.length === 1 ? "issue" : "issues"}`}
            </button>
            <button className="text-fog/40 hover:text-fog" onClick={onCancel} aria-label="Close">
              ✕
            </button>
          </div>

          {/* Coherence drawer — every contradiction in one place, each one a link to its cause. */}
          {cohOpen && (
            <div className="flex-none border-b border-line bg-ink/40 px-5 py-3">
              {issues.length === 0 ? (
                <p className="text-xs text-accent">✓ Nothing on this profile contradicts anything else.</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {issues.map((i: Issue) => (
                    <button
                      key={i.id}
                      onClick={() => goTo(i.field)}
                      className="flex w-full items-start gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-left text-xs hover:border-line-strong"
                    >
                      <span
                        className={
                          "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full " +
                          (i.severity === "error" ? "bg-rose-400" : "bg-amber-400")
                        }
                      />
                      <span className="flex-1 text-fog/70">
                        {i.message}
                        <span className="mt-0.5 block text-fog/40">{i.fix}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-fog/30">Fix →</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid min-h-0 flex-1 grid-cols-[168px_1fr] max-sm:grid-cols-1">
            {/* Rail */}
            <nav className="flex min-h-0 flex-col border-r border-line bg-ink/30 max-sm:border-b max-sm:border-r-0">
              <div className="flex-none p-2.5">
                <input
                  className={input + " py-1 text-xs"}
                  placeholder="Find a setting…"
                  aria-label="Find a setting"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2 pb-2.5 max-sm:flex-row max-sm:overflow-x-auto">
                {CATEGORIES.map((c) => {
                  const n = countSet(profile as unknown as Record<string, unknown>, c.id);
                  const hasIssue = issues.some((i) => fieldByKey(i.field)?.cat === c.id);
                  const on = c.id === cat && !results;
                  return (
                    <li key={c.id}>
                      <button
                        onClick={() => {
                          setQuery("");
                          setCat(c.id);
                        }}
                        aria-current={on}
                        className={
                          "flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] " +
                          (on ? "bg-accent/10 font-semibold text-accent" : "text-fog/60 hover:bg-elevate hover:text-fog")
                        }
                      >
                        {c.label}
                        {hasIssue ? (
                          <span className="ml-auto text-[11px] text-rose-400" title="Has a coherence issue">
                            ▲
                          </span>
                        ) : n ? (
                          <span
                            className={
                              "ml-auto rounded-full px-1.5 text-[10px] font-semibold tabular-nums " +
                              (on ? "bg-accent text-ink" : "bg-iris/80 text-ink")
                            }
                            title={`${n} set here`}
                          >
                            {n}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {/* Panel */}
            <div ref={panelRef} className="min-h-0 overflow-y-auto px-5 py-4">
              {results ? (
                <>
                  <h3 className="text-[15px] font-semibold">
                    {results.length} {results.length === 1 ? "setting matches" : "settings match"} “{query.trim()}”
                  </h3>
                  <p className="mb-4 mt-0.5 text-xs text-fog/40">Across all categories. Clear the search to go back.</p>
                </>
              ) : (
                <>
                  <h3 className="text-[15px] font-semibold">{category.title}</h3>
                  <p className="mb-4 mt-0.5 max-w-[62ch] text-xs text-fog/40">{category.blurb}</p>
                </>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{renderFields(shown)}</div>
              {results && results.length === 0 && (
                <p className="text-xs text-fog/40">No setting matches that. Try a switch name, like “socks5”.</p>
              )}
            </div>
          </div>

          {/* Footer — preview follows you across categories, because it is feedback, not a setting. */}
          <div className="flex-none border-t border-line bg-ink/40">
            <div className="flex items-center gap-2 px-5 py-2.5">
              <button
                className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-fog/50 hover:text-fog"
                onClick={() => setPrevOpen((v) => !v)}
                aria-expanded={prevOpen}
              >
                <span className={"transition-transform " + (prevOpen ? "rotate-90" : "")}>›</span> Launch command
              </button>
              <span className="flex-1" />
              <button className={btnGhost} onClick={onCancel}>
                Cancel
              </button>
              <button
                className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40"
                disabled={!profile.fingerprint}
                onClick={() => onSave(profile)}
              >
                Save profile
              </button>
            </div>
            {prevOpen && (
              <pre className="max-h-28 overflow-auto px-5 pb-3 font-mono text-[11px] leading-relaxed text-fog/60">
                {envLines}chrome.exe {args.join(" \\\n  ")}
              </pre>
            )}
          </div>
        </div>
      </div>
      {libOpen && renderLibrary?.(applyLibrary, () => setLibOpen(false))}
    </>
  );
}

export { MIN_PROFILE_SCREEN_WIDTH, MIN_PROFILE_SCREEN_HEIGHT };
