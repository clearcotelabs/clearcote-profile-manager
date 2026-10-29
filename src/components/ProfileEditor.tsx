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

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Dialog, { DialogHeader } from "./Dialog";
import {
  CATEGORIES,
  FIELDS,
  essentialFields,
  isEssential,
  setOutsideEssentials,
  countSet,
  fieldByKey,
  fieldsIn,
  hostFieldFor,
  isFieldSet,
  searchFields,
  selectOptions,
  type CategoryId,
  type FieldDef,
} from "@/lib/fields";
import { coherenceIssues, coherenceSummary, shouldAutoEnableGeoip, type Issue } from "@/lib/coherence";
import { engineBuild } from "@/lib/engineBuild";
import type { LaunchTarget } from "@/lib/launchTarget";
import {
  PICKER_CUSTOM,
  PICKER_DEFAULT,
  VENDOR_LABEL,
  isCustom,
  modelOptionValue,
  pickerGroups,
  pickerValue,
  randomGpu,
  selectGpuOption,
  withPlatform,
} from "@/lib/gpuPicker";
import {
  profileToArgs,
  profileToEnv,
  proxyString,
  MIN_PROFILE_SCREEN_WIDTH,
  MIN_PROFILE_SCREEN_HEIGHT,
  type FingerprintMeta,
  type Profile,
} from "@/types/profile";
import { api, isWeb, type GeoResult, type HostGpu, type ProxyCheck, type VersionOption } from "@/lib/ipc";
import { describeCheck, UDP_TEST_WARNING } from "@/lib/proxyReport";
import { proxySummary } from "@/lib/profileList";
import { browserCommandName, hostOs, shortcutLabel, type HostOs } from "@/lib/host";
import { normalizeProxyLine } from "@/lib/bulkCreate";
import { proxyProblem } from "../../electron/proxyargs";
import {
  protectedSwitches,
  proxyFromText,
  proxyLabel,
  screenSource,
  withHostScreen,
  withoutScreen,
} from "@/lib/quickCreate";
import CloudFields from "./CloudFields";
import TaskValues from "./TaskValues";
import { t, tRich } from "@/lib/i18n";

const input =
  "w-full rounded-lg border border-line bg-ink/60 px-3 py-1.5 text-sm text-fog outline-none placeholder:text-fog/25 focus:border-accent/60";
const label = "mb-1 block text-[10px] font-medium uppercase tracking-wider text-fog/40";
const btnGhost = "rounded-lg border border-line px-3 py-1.5 text-sm text-fog/70 hover:border-line-strong hover:text-fog";

const randomSeed = () => Math.random().toString(36).slice(2, 14);

/** Where the editor remembers Simple vs All settings. */
const MODE_KEY = "clearcote.editor.mode";

/** The host OS, for the coherence rules that depend on it (the shader dialect off Windows, the
 *  persona platform on a Mac). */
function hostPlatform(): HostOs | undefined {
  return hostOs();
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

/** This display as a browser without a screen override reports it: CSS pixels and the work area.
 *  The renderer's own screen is the monitor this window is on, which is where a launch lands on a
 *  single-display machine. */
function hostScreen() {
  if (typeof window === "undefined" || !window.screen) return undefined;
  const s = window.screen;
  return { width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight, devicePixelRatio: window.devicePixelRatio || undefined };
}

export interface ProfileEditorProps {
  profile: Profile;
  onChange: (p: Profile) => void;
  onSave: (p: Profile) => void;
  /** Save, close and launch in one go ("Create & launch"). Absent: the button is not shown. */
  onSaveAndLaunch?: (p: Profile) => void;
  /** Close request (✕, Esc, backdrop, Cancel). The page asks first when there are unsaved changes. */
  onCancel: () => void;
  /** Differs from what is saved — shown in the footer. */
  dirty?: boolean;
  /** Open on this field (a launch error's "Change version" lands on the version picker). */
  initialField?: string;
  /** Other profiles' names, lower-cased — two cards with the same name are hard to tell apart. */
  takenNames?: string[];
  /** Rendered above the panel when the library picker is open. */
  renderLibrary?: (onApply: (file: string, meta?: FingerprintMeta) => void, onClose: () => void) => React.ReactNode;
  /** What "Latest" launches for this licence, and whether an explicit binary overrides every
   *  version (the header pill's target). Tells the revision-gated rules which build runs. */
  launchTarget?: LaunchTarget | null;
  /** The template this new profile was started from, said above the panel. */
  fromTemplate?: { name: string; detail: string };
}

export default function ProfileEditor({
  profile,
  onChange,
  onSave,
  onSaveAndLaunch,
  onCancel,
  dirty,
  initialField,
  takenNames = [],
  renderLibrary,
  launchTarget,
  fromTemplate,
}: ProfileEditorProps) {
  const titleId = useId();
  const [cat, setCat] = useState<CategoryId>("identity");
  // Simple (the essentials on one page) or All settings (the category rail). The choice is kept;
  // opening on a field Simple does not show switches to All settings for this time only.
  const [simple, setSimple] = useState<boolean>(() => {
    if (initialField && !isEssential(hostFieldFor(initialField)?.key ?? initialField)) return false;
    try {
      return localStorage.getItem(MODE_KEY) !== "all";
    } catch {
      return true;
    }
  });
  const chooseMode = (s: boolean) => {
    setSimple(s);
    try {
      localStorage.setItem(MODE_KEY, s ? "simple" : "all");
    } catch {
      /* private window: the choice lasts this session */
    }
  };
  const [query, setQuery] = useState("");
  const [cohOpen, setCohOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(false);

  // Carried over verbatim from the previous editor.
  const [geo, setGeo] = useState<GeoResult | null>(null);
  /** "Check": the proxy's exit, speed and UDP — reported, never written to the profile. */
  const [check, setCheck] = useState<ProxyCheck | null>(null);
  const [checking, setChecking] = useState(false);
  /** "Test UDP…" was clicked: its warning is showing, waiting for "Test anyway". */
  const [confirmUdp, setConfirmUdp] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [libOpen, setLibOpen] = useState(false);
  const [fpMsg, setFpMsg] = useState<string | null>(null);
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const [revisions, setRevisions] = useState<string[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  /** Set when we turned geoip on for the user, so the editor can say so rather than
   *  silently changing a setting they did not touch. */
  const [autoGeoip, setAutoGeoip] = useState(false);
  /** The GPU driving this machine's display; null until the main process answers (or when an
   *  older preload cannot). Its maker orders the GPU model picker and backs the cross-vendor rule. */
  const [hostGpu, setHostGpu] = useState<HostGpu | null>(null);
  /** The user chose Custom… over a model and has not picked anything since. Without this the
   *  select would snap back to the model the moment Custom… was chosen, because the strings
   *  (deliberately left as the starting point for editing) still match it. */
  const [gpuCustom, setGpuCustom] = useState(false);
  /** A proxy found on the clipboard when a new profile opened — offered, never filled in unasked. */
  const [clipProxy, setClipProxy] = useState<string | null>(null);
  const [pasteMsg, setPasteMsg] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);

  // A new profile without a proxy looks at the clipboard once: copying a proxy and pressing New is
  // the usual way in. The desktop app may read it; a web page only reads it silently when the
  // browser already allows that, so opening the editor never raises a permission prompt.
  useEffect(() => {
    if (profile.id || profile.proxy || typeof navigator === "undefined" || !navigator.clipboard?.readText) return;
    let alive = true;
    (async () => {
      try {
        if (isWeb) {
          const st = await navigator.permissions?.query({ name: "clipboard-read" as PermissionName });
          if (st?.state !== "granted") return;
        }
        const found = proxyFromText(await navigator.clipboard.readText());
        if (alive && found) setClipProxy(found);
      } catch {
        // No focus, no permission, or no clipboard: the Paste button still works.
      }
    })();
    return () => {
      alive = false;
    };
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One load on mount. The `alive` flag stops a late resolve from setting state after unmount, and
  // the optional calls tolerate an older preload that predates these channels.
  useEffect(() => {
    let alive = true;
    api.listVersions?.().then((v) => alive && setVersions(v || [])).catch(() => {});
    api.listRevisions?.().then((r) => alive && setRevisions(r || [])).catch(() => {});
    api.hostGpu?.().then((g) => alive && g && setHostGpu(g)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // A different profile in the same editor starts from its own stored strings, not from the
  // Custom… the previous one was left on.
  useEffect(() => setGpuCustom(false), [profile.id]);

  const set = useCallback(
    <K extends keyof Profile>(k: K, v: Profile[K]) => onChange({ ...profile, [k]: v }),
    [profile, onChange],
  );

  const issues = useMemo(() => {
    const build = engineBuild(profile.browserVersion, { revisions, versions, target: launchTarget });
    return coherenceIssues(profile as unknown as Record<string, unknown>, {
      major: selectedMajor(profile.browserVersion),
      revision: build.revision,
      tier: build.tier,
      hostPlatform: hostPlatform(),
      hostScreen: hostScreen(),
      capturedScreenWarning: profile.fingerprintProfileMeta?.screenWarning,
      hostGpuVendor: hostGpu?.vendor,
    });
  }, [profile, hostGpu, revisions, versions, launchTarget]);
  const summary = coherenceSummary(issues);

  /** Jump to the field an issue blames: switch category, clear the search, scroll and flash it.
   *  A field hosted inside another's control (the GPU strings inside the model picker) lands on
   *  the host, which is what the panel lays out. */
  const goTo = useCallback((key: string) => {
    const f = hostFieldFor(key);
    if (!f) return;
    setQuery("");
    setCat(f.cat);
    if (!isEssential(f.key)) setSimple(false);
    setFlash(f.key);
    window.setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-field="${f.key}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input,select,textarea,button")?.focus({ preventScroll: true });
    }, 0);
    window.setTimeout(() => setFlash(null), 1800);
  }, []);

  useEffect(() => {
    if (initialField) goTo(initialField);
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canSave = !!profile.fingerprint;
  const dupName = !!profile.name?.trim() && takenNames.includes(profile.name.trim().toLowerCase());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault(); // never the browser's "save page as"
        if (canSave && !libOpen) onSave(profile);
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "Enter" && onSaveAndLaunch) {
        e.preventDefault();
        if (canSave && !libOpen) onSaveAndLaunch(profile);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [profile, canSave, libOpen, onSave, onSaveAndLaunch]);

  /** Store a proxy the way typing one does, including turning geoip on the first time. */
  function setProxy(next: string | undefined) {
    // Auto-correct, once: the moment a profile FIRST gains a proxy, turn geoip on so the persona's
    // region follows the exit rather than the host. Fired on the transition — not on every
    // keystroke — so unticking geoip afterwards sticks instead of being switched back on under the
    // user. Legacy profiles that arrive already incoherent are handled by the coherence warning
    // instead, since silently rewriting a saved profile on open is not ours to do.
    setClipProxy(null);
    setCheck(null);
    if (shouldAutoEnableGeoip(profile, next)) {
      onChange({ ...profile, proxy: next, geoip: true });
      setAutoGeoip(true);
      return;
    }
    if (!next) setAutoGeoip(false);
    set("proxy", next);
  }

  /** Check. UDP is tested only with Relay UDP on, or with `udp` (the "Test UDP" button, after its
   *  warning): a UDP test can move a residential sticky session to another exit. */
  async function checkProxyNow(udp = false) {
    if (!api.proxyCheck) return;
    setChecking(true);
    setCheck(null);
    setConfirmUdp(false);
    try {
      setCheck(await api.proxyCheck(profile, udp ? { udp: true } : undefined));
    } catch (e) {
      setCheck({ ok: false, error: (e as Error)?.message || String(e) });
    } finally {
      setChecking(false);
    }
  }

  /** The Paste button: a click is the user gesture a web page needs to read the clipboard. */
  async function pasteProxy() {
    setPasteMsg(null);
    try {
      const found = proxyFromText(await navigator.clipboard.readText());
      if (found) setProxy(found);
      else setPasteMsg(t("The clipboard doesn't hold a proxy address (host:port, with or without a login)."));
    } catch {
      setPasteMsg(t("The clipboard can't be read here. Paste into the field with Ctrl+V instead."));
    }
  }

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
        // value the user chose. lastGeo records that the WebRTC IP came from this lookup: while the
        // field still holds it, a launch looks the exit up again instead of keeping the snapshot.
        onChange({
          ...profile,
          timezone: r.timezone || profile.timezone,
          acceptLanguage: r.acceptLanguage || profile.acceptLanguage,
          location: r.lat != null && r.lon != null ? `${r.lat},${r.lon}` : profile.location,
          webrtcIp: r.ip || profile.webrtcIp,
          ...(r.ip
            ? { lastGeo: { ip: r.ip, country: r.country, countryCode: r.countryCode, city: r.city, at: new Date().toISOString(), proxy: proxySummary(profile.proxy) ?? "" } }
            : {}),
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

  // The switches a proxy adds, said in words — they show in the launch command and get asked about.
  const protectedList = protectedSwitches(profile);
  const protectedView = (
    <ul className="mt-2 flex flex-col gap-2">
      {protectedList.map((s) => (
        <li key={s.arg} className="flex items-start gap-2 text-xs">
          <svg aria-hidden="true" viewBox="0 0 24 24" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="11" width="16" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span className="text-fog/60">
            <span className="font-medium text-fog">{t(s.title)}.</span> {t(s.why)}{" "}
            <code className="font-mono text-[10px] text-fog/40">{s.arg}</code>
          </span>
        </li>
      ))}
    </ul>
  );

  const host = hostScreen();
  const screenFrom = screenSource(profile, host);

  const results = query.trim() ? searchFields(query) : null;
  const shown = (results ?? (simple ? essentialFields() : fieldsIn(cat))).filter(
    (f) => !f.showWhen || f.showWhen(profile as unknown as Record<string, unknown>),
  );
  const hiddenSet = simple ? setOutsideEssentials(profile as unknown as Record<string, unknown>) : 0;

  // ── Field rendering ────────────────────────────────────────────────────────
  function why(f: FieldDef) {
    if (!f.why) return null;
    return (
      <button
        type="button"
        title={t(f.why)}
        aria-label={t("Why: {label}", { label: t(f.label) })}
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
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-iris" title={t("You set this")} />
        )}
        {t(f.label)}
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
            <span className="font-medium text-fog">{t(f.label)}</span>
            {f.desc ? <> — {t(f.desc)}</> : null}
            {f.why ? why(f) : null}
            {f.hint ? <span className="mt-1 block text-[11px] text-fog/40">{t(f.hint)}</span> : null}
          </span>
        </label>
      );
    }

    if (f.type === "select") {
      const cur = textValue(f);
      const options = selectOptions(f, profile as unknown as Record<string, unknown>, cur);
      return (
        <>
          {labelFor(f)}
          <select
            className={cls}
            value={cur || f.defaultOption || (options[0]?.value ?? "")}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value;
              const unset = f.defaultOption !== undefined && v === f.defaultOption;
              const store = unset ? undefined : f.numeric ? Number(v) : v;
              // The persona platform decides which form a GPU model's strings take, so a model
              // chosen on Windows is rewritten in Linux's form when the platform moves (and back).
              if (f.key === "platform") {
                onChange(withPlatform(profile, store));
                return;
              }
              set(f.key as keyof Profile, store as never);
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
          {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{t(f.hint)}</p> : null}
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
            placeholder={f.placeholder ? t(f.placeholder) : undefined}
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
            placeholder={f.placeholder ? t(f.placeholder) : undefined}
            disabled={disabled}
            // Compared against "" rather than tested for truthiness, so a real 0 survives —
            // maxTouchPoints: 0 is a mouse-only desktop, not an empty field.
            onChange={(e) => set(f.key as keyof Profile, (e.target.value === "" ? undefined : Number(e.target.value)) as never)}
          />
          {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{t(f.hint)}</p> : null}
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
          placeholder={f.placeholder ? t(f.placeholder) : undefined}
          disabled={disabled}
          onChange={(e) => storeText(f, e.target.value)}
        />
        {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{t(f.hint)}</p> : null}
      </>
    );
  }

  function renderCustom(f: FieldDef) {
    switch (f.custom) {
      case "cloud":
        return <CloudFields profile={profile} onChange={onChange} />;

      case "gpuModel": {
        // A select over the model table, writing BOTH stored strings in the persona platform's
        // form; Custom… shows the two raw string fields (hosted here, see fields.ts) prefilled
        // with whatever is stored, so a legacy profile's hand-typed strings come through intact.
        const disabled = !!(f.disabledBy && (profile as unknown as Record<string, unknown>)[f.disabledBy]);
        const hostVendor = hostGpu?.vendor ?? "unknown";
        const value = pickerValue(profile, gpuCustom);
        const custom = isCustom(profile, gpuCustom);
        const hostLine =
          hostGpu && hostGpu.vendor !== "unknown"
            ? t("This machine: {gpu} — its maker's models are listed first.", { gpu: hostGpu.name || VENDOR_LABEL[hostGpu.vendor] })
            : hostGpu
              ? t("This machine's GPU maker could not be detected, so every vendor is listed.")
              : null;
        return (
          <>
            <div className="flex items-center justify-between">
              {labelFor(f)}
              <button
                type="button"
                className={btnGhost + " -mt-1 py-1 text-xs disabled:opacity-40"}
                disabled={disabled}
                title={t("A random model of this machine's GPU maker, never the one already chosen")}
                onClick={() => {
                  onChange(randomGpu(profile, hostVendor));
                  setGpuCustom(false);
                }}
              >
                {t("Pick one at random")}
              </button>
            </div>
            <select
              aria-label={t(f.label)}
              className={input + (disabled ? " opacity-40" : "")}
              value={value}
              disabled={disabled}
              onChange={(e) => {
                const r = selectGpuOption(profile, e.target.value);
                onChange(r.profile);
                setGpuCustom(r.forceCustom);
              }}
            >
              <option value={PICKER_DEFAULT}>{t("Persona default (engine chooses)")}</option>
              {pickerGroups(hostVendor).map((g) => (
                <optgroup key={g.vendor} label={t(g.label)}>
                  {g.models.map((m) => (
                    <option key={modelOptionValue(m)} value={modelOptionValue(m)}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
              <option value={PICKER_CUSTOM}>{t("Custom…")}</option>
            </select>
            {f.hint ? <p className="mt-1 text-[11px] text-fog/40">{t(f.hint)}</p> : null}
            {profile.platform === "macos" ? (
              <p className="mt-0.5 text-[11px] text-warn/80" data-gpu-macos="1">
                {t("The list has Windows and Linux strings only, so a macOS persona keeps Persona default.")}
              </p>
            ) : null}
            {hostLine ? (
              <p className="mt-0.5 text-[11px] text-fog/40" data-gpu-host={hostVendor}>
                {hostLine}
              </p>
            ) : null}
            {custom && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2" data-gpu-custom="1">
                {(f.reads ?? []).map((k) => fieldByKey(k)).map((h) => (h ? renderField(h) : null))}
              </div>
            )}
          </>
        );
      }
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
              <button className={btnGhost} onClick={() => set("fingerprint", randomSeed())} title={t("Randomize")}>
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
              placeholder={f.placeholder ? t(f.placeholder) : undefined}
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
              placeholder={f.placeholder ? t(f.placeholder) : undefined}
              onChange={(e) => {
                const v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean);
                set(key, (v.length ? v : undefined) as never);
              }}
            />
          </>
        );
      }

      case "vars":
        return (
          <>
            {labelFor(f)}
            <TaskValues value={profile.vars} onChange={(v) => set("vars", v as never)} />
          </>
        );

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
            <p className="mt-1 text-[11px] text-fog/40">{t("One flag per line. Appended verbatim, after everything else.")}</p>
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
              <option value="latest">{t("Latest (recommended)")}</option>
              {versions.map((v) => (
                <option key={v.version} value={String(v.major)}>
                  {v.major} · {v.tier === "pro" ? "Pro" : t("Free")} ({v.version})
                </option>
              ))}
              {revisions.length > 0 && (
                <optgroup label={t("Pin an exact Pro rebuild")}>
                  {revisions.map((r, i) => (
                    <option key={r} value={r}>
                      {r}
                      {i === 0 ? " · " + t("current") : ""}
                    </option>
                  ))}
                </optgroup>
              )}
              {/* A pin that is no longer published must not silently read as "Latest". */}
              {orphan && <option value={profile.browserVersion}>{t("{version} · pinned", { version: profile.browserVersion ?? "" })}</option>}
            </select>
            <p className="mt-1 text-[11px] text-fog/40">
              {t("Latest is the newest of your tier. A Pro build needs a license key in Settings.")}
              {revisions.length > 0
                ? " " + t("Latest and a bare major both follow the current Pro pin, which moves when a rebuild ships — pin a revision for reproducible runs.")
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
              <span className="-mt-1 flex gap-1.5">
                {!profile.proxy && (
                  <button type="button" className={btnGhost + " py-1 text-xs"} onClick={pasteProxy} data-proxy-paste="1">
                    {t("Paste")}
                  </button>
                )}
                {profile.proxy && api.proxyCheck && (
                  <button
                    type="button"
                    className={btnGhost + " py-1 text-xs"}
                    onClick={() => void checkProxyNow()}
                    disabled={checking}
                    title={profile.socks5Udp ? t("Does it work, where does it exit, and does it carry UDP? Changes nothing in the profile.") : t("Does it work and where does it exit? Changes nothing. UDP is tested only when you ask.")}
                    data-proxy-check-btn="1"
                  >
                    {checking ? t("Checking…") : t("Check")}
                  </button>
                )}
                {profile.proxy && (
                  <button className={btnGhost + " py-1 text-xs"} onClick={resolveGeo} disabled={resolving}>
                    {resolving ? t("Resolving…") : t("Resolve from proxy →")}
                  </button>
                )}
              </span>
            </div>
            <input
              className={input + " font-mono"}
              value={proxyString(profile.proxy)}
              placeholder="http://user:pass@host:8080  ·  socks5://user:pass@host:1080  ·  host:port:user:pass"
              data-proxy-input="1"
              onPaste={(e) => {
                // Any vendor form (host:port:user:pass, user:pass:host:port, …) becomes the URL form
                // the launcher reads — the same conversion "From proxy list…" does. Only when the
                // paste replaces the whole field: a paste into the middle of an address is editing.
                const el = e.currentTarget;
                const whole = !el.value || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
                const text = e.clipboardData.getData("text").trim();
                const url = normalizeProxyLine(text);
                if (whole && url !== text) {
                  e.preventDefault();
                  setProxy(url);
                }
              }}
              onChange={(e) => setProxy(e.target.value || undefined)}
              onBlur={(e) => {
                // A typed address gets the same conversion once the field is left.
                const text = e.currentTarget.value.trim();
                const url = text ? normalizeProxyLine(text) : text;
                if (url !== e.currentTarget.value) set("proxy", url || undefined);
              }}
            />
            {proxyProblem(profile.proxy) && (
              <p className="mt-1 text-[11px] text-danger" role="alert" data-proxy-problem="1">
                {t(proxyProblem(profile.proxy) ?? "")}
              </p>
            )}
            {pasteMsg && !profile.proxy && <p className="mt-1 text-[11px] text-warn">{pasteMsg}</p>}
            {checking && (
              <p className="mt-1 text-[11px] text-fog/50" role="status">
                {profile.socks5Udp ? t("Checking the proxy and whether it carries UDP… (a few seconds)") : t("Checking the proxy… (a few seconds)")}
              </p>
            )}
            {check &&
              (() => {
                const d = describeCheck(check, profile);
                const box =
                  d.tone === "ok"
                    ? "border-ok/40 bg-ok/5 text-fog/80"
                    : d.tone === "warn"
                      ? "border-warn/40 bg-warn/5 text-fog/80"
                      : "border-danger/40 bg-danger/5 text-fog/80";
                const head = d.tone === "ok" ? "text-ok" : d.tone === "warn" ? "text-warn" : "text-danger";
                return (
                  <div className={"mt-1.5 rounded-lg border px-3 py-2 text-[11px] leading-relaxed " + box} role="status" data-proxy-check={d.tone}>
                    {d.lines.map((l, i) => (
                      <p key={i} className={i === 0 ? "font-medium " + head : "mt-0.5"}>
                        {t(l)}
                      </p>
                    ))}
                    {check.ok && check.udpSkipped && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2" data-udp-test={confirmUdp ? "confirm" : "offer"}>
                        {confirmUdp ? (
                          <>
                            <span className="text-warn">{t(UDP_TEST_WARNING)}</span>
                            <button className={btnGhost + " py-0.5 text-[11px]"} onClick={() => void checkProxyNow(true)} data-udp-test-go="1">
                              {t("Test anyway")}
                            </button>
                            <button className={btnGhost + " py-0.5 text-[11px]"} onClick={() => setConfirmUdp(false)}>
                              {t("Cancel")}
                            </button>
                          </>
                        ) : (
                          <button className={btnGhost + " py-0.5 text-[11px]"} onClick={() => setConfirmUdp(true)} data-udp-test-btn="1">
                            {t("Test UDP…")}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            {autoGeoip && profile.geoip && (
              <p className="mt-1 text-[11px] text-accent">
                {t("geoip switched on — timezone, language and position will follow this proxy's exit region at launch. Untick it below if you don't want that.")}
              </p>
            )}
            {geo && (
              <p className={"mt-1 text-[11px] " + (geo.ok ? "text-accent" : "text-amber-500")}>
                {geo.ok
                  ? t("egress {ip} · {country} · {timezone} · {language}", {
                      ip: String(geo.ip),
                      country: geo.country ?? "?",
                      timezone: geo.timezone ?? "?",
                      language: geo.acceptLanguage ?? "?",
                    })
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
                  {t("Clear")}
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
                      {meta?.source === "library" ? " · " + t("library") : ""}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-fog/50">{meta?.renderer || t("captured profile")}</p>
                  <p className="mt-0.5 text-[11px] text-fog/40">
                    {[meta?.cores ? t("{n} cores", { n: meta.cores }) : null, meta?.memory ? t("{n} GB", { n: meta.memory }) : null, meta?.screen]
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
                  {t("Load a real machine's GPU, screen, fonts, voices and WebGL. Its values override the seed persona.")}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button className={btnGhost + " py-1 text-xs"} onClick={importFp}>
                  {t("Import from file…")}
                </button>
                <button className={btnGhost + " py-1 text-xs"} onClick={() => setLibOpen(true)}>
                  {t("Browse library…")}
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
        {f.key === "name" && dupName && (
          <p className="mt-1 text-[11px] text-warn" role="status">
            {t("Another profile is already called “{name}”. A different name keeps the two apart in the list.", { name: profile.name.trim() })}
          </p>
        )}
      </div>
    );
  }

  /** Render a category's fields, wrapping any grouped run in its own bordered sub-panel. */
  function renderFields(list: FieldDef[]) {
    const out: React.ReactNode[] = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      // Laid out by the control that hosts it, not here.
      if (f.hostedBy) continue;
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
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-fog/40">{t(groupName)}</p>
            {groupName === "Screen dimensions" && (
              <span className="flex flex-wrap items-center justify-end gap-1.5" data-screen-source={screenFrom}>
                {screenFrom === "host" && <span className="text-[11px] text-ok">{t("✓ This display")}</span>}
                {host && screenFrom !== "host" && (
                  <button
                    type="button"
                    className={btnGhost + " py-1 text-xs"}
                    onClick={() => onChange(withHostScreen(profile, host))}
                    title={t("Fill all four and the pixel ratio from this display: {width} × {height}, work area {availWidth} × {availHeight}, pixel ratio {ratio}", {
                      width: host.width,
                      height: host.height,
                      availWidth: host.availWidth,
                      availHeight: host.availHeight,
                      ratio: host.devicePixelRatio ?? 1,
                    })}
                    data-use-display="1"
                  >
                    {t("Use this display ({width} × {height})", { width: host.width, height: host.height })}
                  </button>
                )}
                {screenFrom !== "empty" && (
                  <button
                    type="button"
                    className={btnGhost + " py-1 text-xs"}
                    onClick={() => onChange(withoutScreen(profile))}
                    title={t("Empty all four and the pixel ratio: the seed or capture brings a screen and ratio that agree")}
                  >
                    {t("Clear")}
                  </button>
                )}
              </span>
            )}
          </div>
          {note && <p className="mb-3 mt-1 text-[11px] text-fog/40">{t(note)}</p>}
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
      <Dialog onClose={onCancel} labelledBy={titleId} className="max-h-[720px] max-w-4xl">
          {/* Header — pinned, so Save is never a scroll away. */}
          <DialogHeader id={titleId} title={profile.id ? t("Edit profile") : t("New profile")} onClose={onCancel}>
            <span className="min-w-0 truncate text-sm text-fog/40">{profile.name || t("Untitled")}</span>
            <span className="flex-1" />
            <div className="flex rounded-lg border border-line p-0.5 text-xs" role="group" aria-label={t("How much to show")} data-editor-mode={simple ? "simple" : "all"}>
              <button
                type="button"
                aria-pressed={simple}
                onClick={() => chooseMode(true)}
                className={"rounded-md px-2.5 py-1 " + (simple ? "bg-accent/15 font-semibold text-accent" : "text-fog/55 hover:text-fog")}
              >
                {t("Simple")}
              </button>
              <button
                type="button"
                aria-pressed={!simple}
                onClick={() => chooseMode(false)}
                className={"rounded-md px-2.5 py-1 " + (!simple ? "bg-accent/15 font-semibold text-accent" : "text-fog/55 hover:text-fog")}
              >
                {t("All settings")}
              </button>
            </div>
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
                ? t("✓ coherent")
                : issues.length === 1
                  ? t("▲ 1 issue")
                  : t("▲ {n} issues", { n: issues.length })}
            </button>
          </DialogHeader>

          {/* Coherence drawer — every contradiction in one place, each one a link to its cause. */}
          {cohOpen && (
            <div className="flex-none border-b border-line bg-ink/40 px-5 py-3">
              {issues.length === 0 ? (
                <p className="text-xs text-accent">{t("✓ Nothing on this profile contradicts anything else.")}</p>
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
                        {t(i.message)}
                        <span className="mt-0.5 block text-fog/40">{t(i.fix)}</span>
                      </span>
                      <span className="shrink-0 text-[11px] text-fog/30">{t("Fix →")}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className={"grid min-h-0 flex-1 " + (simple ? "grid-cols-1" : "grid-cols-[168px_1fr] max-sm:grid-cols-1")}>
            {/* Rail — All settings only. */}
            {!simple && (
            <nav className="flex min-h-0 flex-col border-r border-line bg-ink/30 max-sm:border-b max-sm:border-r-0">
              <div className="flex-none p-2.5">
                <input
                  className={input + " py-1 text-xs"}
                  placeholder={t("Find a setting…")}
                  aria-label={t("Find a setting")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape" && query) {
                      e.preventDefault(); // the dialog leaves a used Esc alone
                      setQuery("");
                    }
                  }}
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
                        {t(c.label)}
                        {hasIssue ? (
                          <span className="ml-auto text-[11px] text-rose-400" title={t("Has a coherence issue")}>
                            ▲
                          </span>
                        ) : n ? (
                          <span
                            className={
                              "ml-auto rounded-full px-1.5 text-[10px] font-semibold tabular-nums " +
                              (on ? "bg-accent text-ink" : "bg-iris/80 text-ink")
                            }
                            title={t("{n} set here", { n })}
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
            )}

            {/* Panel */}
            <div ref={panelRef} className="min-h-0 overflow-y-auto px-5 py-4">
              {fromTemplate && !profile.id && (
                <p
                  className="mb-3 rounded-lg border border-iris/40 bg-iris/10 px-3 py-2 text-xs text-fog/80"
                  role="status"
                  data-from-template={fromTemplate.name}
                >
                  {tRich("From template {name} · new seed · {detail}", {
                    name: <span className="font-semibold text-fog">{fromTemplate.name}</span>,
                    detail: fromTemplate.detail,
                  })}
                </p>
              )}
              {/* Above every category: a new profile opens on Identity, the proxy lives under Network. */}
              {clipProxy && !profile.proxy && (
                <div
                  className="mb-4 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-xs"
                  role="status"
                  data-clip-proxy="1"
                >
                  <span className="min-w-0 flex-1 truncate text-fog/80">
                    {tRich("Proxy on your clipboard: {proxy}", {
                      proxy: <span className="font-mono text-fog">{proxyLabel(clipProxy)}</span>,
                    })}
                  </span>
                  <button
                    type="button"
                    className="rounded-md bg-accent px-2.5 py-1 font-semibold text-ink"
                    onClick={() => setProxy(clipProxy)}
                  >
                    {t("Use it")}
                  </button>
                  <button type="button" className="text-fog/50 hover:text-fog" onClick={() => setClipProxy(null)}>
                    {t("Dismiss")}
                  </button>
                </div>
              )}
              {(simple || cat === "network") && !results && protectedList.length > 0 && (
                <div className="mb-4 rounded-lg border border-line/70 bg-ink/30 p-3" data-protected="1">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-fog/40">{t("Always on while a proxy is set")}</p>
                  {protectedView}
                </div>
              )}
              {results ? (
                <>
                  <h3 className="text-[15px] font-semibold">
                    {results.length === 1
                      ? t("1 setting matches “{query}”", { query: query.trim() })
                      : t("{n} settings match “{query}”", { n: results.length, query: query.trim() })}
                  </h3>
                  <p className="mb-4 mt-0.5 text-xs text-fog/40">{t("Across all categories. Clear the search to go back.")}</p>
                </>
              ) : simple ? (
                <>
                  <h3 className="text-[15px] font-semibold">{t("Essentials")}</h3>
                  <p className="mb-4 mt-0.5 max-w-[62ch] text-xs text-fog/40">
                    {hiddenSet
                      ? (() => {
                          const btn = (s: string) => (
                            <button type="button" className="text-accent hover:underline" onClick={() => chooseMode(false)} data-hidden-set={hiddenSet}>
                              {s}
                            </button>
                          );
                          return hiddenSet === 1
                            ? tRich("What most profiles need. Everything else keeps its default — <b>1 more setting you set is in All settings</b>", { b: btn })
                            : tRich("What most profiles need. Everything else keeps its default — <b>{n} more settings you set are in All settings</b>", {
                                b: (s) => btn(s.replace("{n}", String(hiddenSet))),
                              });
                        })()
                      : t("What most profiles need. Everything else keeps its default; All settings has the rest.")}
                  </p>
                </>
              ) : (
                <>
                  <h3 className="text-[15px] font-semibold">{t(category.title)}</h3>
                  <p className="mb-4 mt-0.5 max-w-[62ch] text-xs text-fog/40">{t(category.blurb)}</p>
                </>
              )}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{renderFields(shown)}</div>
              {results && results.length === 0 && (
                <p className="text-xs text-fog/40">{t("No setting matches that. Try a switch name, like “socks5”.")}</p>
              )}
            </div>
          </div>

          {/* Footer — preview follows you across categories, because it is feedback, not a setting. */}
          <div className="flex-none border-t border-line bg-ink/40">
            <div className="flex items-center gap-2 px-5 py-2.5">
              <button
                className="flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-1 text-xs text-fog/50 hover:text-fog"
                onClick={() => setPrevOpen((v) => !v)}
                aria-expanded={prevOpen}
              >
                <span className={"transition-transform " + (prevOpen ? "rotate-90" : "")}>›</span> {t("Launch command")}
              </button>
              <span className="flex-1" />
              {dirty && (
                <span className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-fog/45" role="status">
                  <span className="h-1.5 w-1.5 rounded-full bg-iris" /> {t("Unsaved changes")}
                </span>
              )}
              <button className={btnGhost} onClick={onCancel}>
                {t("Cancel")}
              </button>
              <button
                className="whitespace-nowrap rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a] disabled:opacity-40"
                disabled={!canSave}
                onClick={() => onSave(profile)}
                title={t("Save ({shortcut})", { shortcut: shortcutLabel("S", hostPlatform()) })}
              >
                {t("Save profile")}
              </button>
              {onSaveAndLaunch && (
                <button
                  className="whitespace-nowrap rounded-lg border border-accent/60 px-4 py-1.5 text-sm font-semibold text-accent hover:bg-accent/10 disabled:opacity-40"
                  disabled={!canSave}
                  onClick={() => onSaveAndLaunch(profile)}
                  title={
                    profile.id
                      ? t("Save and launch ({shortcut})", { shortcut: shortcutLabel("Enter", hostPlatform()) })
                      : t("Create and launch ({shortcut})", { shortcut: shortcutLabel("Enter", hostPlatform()) })
                  }
                  data-save-launch="1"
                >
                  {profile.id ? t("Save & launch") : t("Create & launch")}
                </button>
              )}
            </div>
            {prevOpen && protectedList.length > 0 && (
              <div className="px-5 pb-2" data-protected-launch="1">
                <p className="text-[10px] font-medium uppercase tracking-wider text-fog/40">{t("Added because a proxy is set")}</p>
                {protectedView}
              </div>
            )}
            {prevOpen && (
              <pre className="max-h-28 overflow-auto px-5 pb-3 font-mono text-[11px] leading-relaxed text-fog/60">
                {envLines}
                {browserCommandName(hostPlatform())} {args.join(" \\\n  ")}
              </pre>
            )}
          </div>
      </Dialog>
      {libOpen && renderLibrary?.(applyLibrary, () => setLibOpen(false))}
    </>
  );
}

export { MIN_PROFILE_SCREEN_WIDTH, MIN_PROFILE_SCREEN_HEIGHT };
