"use client";

// Settings, laid out like the profile editor: a pinned header, a section rail, ONE scrolling panel
// and a pinned footer. The previous modal was a single box centred in a `fixed inset-0 flex` overlay
// with no height cap and no overflow, so once its content outgrew the window both its top and its
// Done button were pushed off-screen with nothing able to scroll them back. The frame (and Esc,
// focus, scroll locking) now comes from the shared Dialog, and only the panel scrolls.

import { useEffect, useId, useState } from "react";
import { api, type Settings, type LicenseStatus, type CloudAccount } from "@/lib/ipc";
import { needsHelper } from "@/lib/webPreview";
import Dialog, { DialogFooter, DialogHeader } from "./Dialog";
import StorageSection from "./StorageSection";
import { browserFileName, hostOs } from "@/lib/host";
import { LOCALES, LOCALE_META, setLocale, t, tRich, tx, useLocale, type Locale } from "@/lib/i18n";

export type Section = "general" | "browser" | "license" | "cloud" | "updates" | "storage";

/** Where a free key comes from: sign in with GitHub, Licenses, "Get it free" (the site's own FAQ). */
export const FREE_KEY_URL = "https://www.clearcotelabs.com/dashboard/licenses";
/** Where a cloud API key is created, and where the cloud balance is topped up. */
export const API_KEYS_URL = "https://www.clearcotelabs.com/dashboard/api-keys";
export const TOPUP_URL = "https://www.clearcotelabs.com/dashboard/browsers";

const SECTIONS: { id: Section; label: string; title: string; blurb: string }[] = [
  {
    id: "general",
    label: tx("General"),
    title: tx("General"),
    blurb: tx("How the app behaves."),
  },
  {
    id: "browser",
    label: tx("Browser"),
    title: tx("Browser"),
    blurb: tx("Which Clearcote build profiles launch with."),
  },
  {
    id: "license",
    label: tx("Licence"),
    title: tx("Licence"),
    blurb: tx("A key unlocks the licence-gated browser. It is only sent to the licence service, and only when a key is set."),
  },
  {
    id: "cloud",
    label: tx("Cloud"),
    title: tx("Cloud"),
    blurb: tx("Run profiles on Clearcote's servers instead of this PC, paid from your Clearcote balance."),
  },
  {
    id: "updates",
    label: tx("Updates"),
    title: tx("App updates"),
    blurb: tx("Know when a new version of this app is out. Nothing is installed without you."),
  },
  {
    id: "storage",
    label: tx("Storage"),
    title: tx("Storage"),
    blurb: tx("What the app keeps on disk, what each part is for, and what can go."),
  },
];

const input =
  "w-full min-w-0 rounded-lg bg-ink/70 border border-line px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";

function hostIsWindows(): boolean {
  if (typeof navigator === "undefined") return true;
  return `${navigator.platform} ${navigator.userAgent}`.toLowerCase().includes("win");
}

/** A titled group of rows — the one visual unit every section is built from. */
function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-line rounded-xl border border-line bg-ink/30">{children}</div>;
}

/** Label + explanation on the left, the control on the right; stacks on a narrow window. */
function Row({
  title,
  hint,
  children,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fog">{title}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-fog/45">{hint}</div>}
      </div>
      {children && <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={
        "relative h-5 w-9 shrink-0 rounded-full transition-colors " + (checked ? "bg-accent" : "bg-line-strong")
      }
    >
      <span
        className={
          "absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform " +
          (checked ? "translate-x-[18px]" : "translate-x-0.5")
        }
      />
    </button>
  );
}

export default function SettingsModal({
  binary,
  settings,
  onPick,
  onSaveSettings,
  onSettingsReload,
  autoStartLogin = false,
  onClose,
  initialSection = "browser",
}: {
  binary: string | null;
  settings: Settings;
  onPick: () => void;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
  /** Settings changed outside this window (a key saved by "Use my Clearcote account"): here they are. */
  onSettingsReload?: (s: Settings) => void;
  /** Opened from "Use my Clearcote account": start the sign-in straight away. */
  autoStartLogin?: boolean;
  onClose: () => void;
  /** Open on this section — the header pill and a launch error's action point at the right one. */
  initialSection?: Section;
}) {
  const locale = useLocale();
  const [section, setSection] = useState<Section>(initialSection);
  const current = SECTIONS.find((s) => s.id === section)!;
  const titleId = useId();

  // ── Licence ──────────────────────────────────────────────────────────────
  const [key, setKey] = useState(settings.licenseKey || "");
  const [reveal, setReveal] = useState(false);
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const dirty = (key.trim() || undefined) !== (settings.licenseKey || undefined);

  async function saveKey() {
    const next = key.trim() || undefined;
    await onSaveSettings({ licenseKey: next });
    setStatus(null);
    // A saved key is checked at once, so a typo shows up here instead of at the next launch.
    if (next) await checkKey(next);
  }
  async function checkKey(saved?: string) {
    setChecking(true);
    setStatus(null);
    try {
      if (saved === undefined && dirty) await onSaveSettings({ licenseKey: key.trim() || undefined });
      setStatus(await api.license.check(saved ?? (key.trim() || undefined)));
    } finally {
      setChecking(false);
    }
  }

  // "Use my Clearcote account": sign in on clearcotelabs.com, approve there, and the key is saved for you
  // (electron/devicelogin.ts). The key itself never comes back to this window.
  type Login =
    | { phase: "starting" }
    | { phase: "waiting"; id: string; userCode: string; uri: string; interval: number }
    | { phase: "done"; plan?: string; account?: string }
    | { phase: "error"; error: string };
  const [login, setLogin] = useState<Login | null>(null);
  async function useAccount() {
    if (!api.license.loginStart) return;
    setLogin({ phase: "starting" });
    let r;
    try {
      r = await api.license.loginStart();
    } catch (e) {
      // A helper from before this call existed answers "Unknown call".
      const msg = String((e as Error)?.message || e);
      return setLogin({
        phase: "error",
        error: /Unknown call/.test(msg)
          ? t("Your Clearcote helper is older than this feature. Download the newest helper and start it again.")
          : msg,
      });
    }
    if (!r.ok) return setLogin(needsHelper(r) ? null : { phase: "error", error: r.error });
    void api.openExternal(r.verificationUri);
    setLogin({ phase: "waiting", id: r.id, userCode: r.userCode, uri: r.verificationUri, interval: r.interval });
  }
  useEffect(() => {
    if (autoStartLogin) void useAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (login?.phase !== "waiting" || !api.license.loginPoll) return;
    let stop = false;
    const { id, interval } = login;
    const tick = async () => {
      if (stop) return;
      const r = await api.license.loginPoll!(id).catch((e) => ({ status: "error" as const, error: String(e?.message || e) }));
      if (stop) return;
      if (r.status === "approved") {
        const s = await api.settings.get();
        setKey(s.licenseKey || "");
        onSettingsReload?.(s);
        setLogin({ phase: "done", plan: r.plan, account: r.account });
        setStatus(await api.license.check());
        return;
      }
      if (r.status === "denied" || r.status === "expired") return setLogin({ phase: "error", error: r.error });
      setTimeout(tick, Math.max(2, interval) * 1000);
    };
    const timer = setTimeout(tick, Math.max(2, interval) * 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login?.phase === "waiting" ? login.id : null]);

  // ── Cloud ────────────────────────────────────────────────────────────────
  const [apiKey, setApiKey] = useState(settings.cloudApiKey || "");
  const [revealApi, setRevealApi] = useState(false);
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [checkingApi, setCheckingApi] = useState(false);
  const apiDirty = (apiKey.trim() || undefined) !== (settings.cloudApiKey || undefined);
  const apiKeyLooksWrong = !!apiKey.trim() && !apiKey.trim().startsWith("cc_live_");

  async function saveApiKey() {
    const next = apiKey.trim() || undefined;
    await onSaveSettings({ cloudApiKey: next });
    setAccount(null);
    // Checked at once, like the licence key, so a typo shows up here and not at the first start.
    if (next) await checkApiKey(next);
  }
  async function checkApiKey(saved?: string) {
    setCheckingApi(true);
    setAccount(null);
    try {
      setAccount(await api.cloud.account(saved ?? (apiKey.trim() || undefined)));
    } finally {
      setCheckingApi(false);
    }
  }

  // ── Updates ──────────────────────────────────────────────────────────────
  const [updMsg, setUpdMsg] = useState<string | null>(null);
  const [updChecking, setUpdChecking] = useState(false);
  async function checkNow() {
    setUpdChecking(true);
    setUpdMsg(null);
    try {
      const u = await api.update.check(true);
      setUpdMsg(
        !u
          ? t("Could not reach GitHub.")
          : u.available
            ? t("Version {version} is available — see the banner.", { version: u.latest })
            : t("You're up to date ({version}).", { version: u.current }),
      );
    } finally {
      setUpdChecking(false);
    }
  }

  const exe = browserFileName(hostOs() ?? (hostIsWindows() ? "windows" : "linux"));
  const custom = settings.binaryPath;

  return (
    <Dialog onClose={onClose} labelledBy={titleId} className="max-h-[620px] max-w-3xl">
      <DialogHeader id={titleId} title={t("Settings")} onClose={onClose} />

        <div className="grid min-h-0 flex-1 grid-cols-[160px_1fr] max-sm:grid-cols-1 max-sm:grid-rows-[auto_1fr]">
          {/* Rail — a row of tabs on a narrow window */}
          <nav className="min-h-0 border-r border-line bg-ink/30 max-sm:border-b max-sm:border-r-0">
            <ul className="flex flex-col gap-0.5 p-2.5 max-sm:flex-row max-sm:overflow-x-auto">
              {SECTIONS.map((s) => {
                const on = s.id === section;
                return (
                  <li key={s.id}>
                    <button
                      onClick={() => setSection(s.id)}
                      aria-current={on}
                      className={
                        "flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left text-[13px] " +
                        (on ? "bg-accent/10 font-semibold text-accent" : "text-fog/60 hover:bg-elevate hover:text-fog")
                      }
                    >
                      {t(s.label)}
                      {s.id === "license" && settings.licenseKey && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" title={t("Key set")} />
                      )}
                      {s.id === "cloud" && settings.cloudApiKey && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent" title={t("API key set")} />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Panel — the only thing that scrolls */}
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            <h3 className="text-[15px] font-semibold">{t(current.title)}</h3>
            <p className="mb-4 mt-0.5 max-w-[62ch] text-xs text-fog/40">{t(current.blurb)}</p>

            {section === "general" && (
              <div className="space-y-4">
              <Card>
                <div className="px-4 py-3.5">
                  <label htmlFor="app-language" className="text-[13px] font-medium text-fog">
                    {t("Language")}
                  </label>
                  <p className="mt-0.5 text-xs leading-relaxed text-fog/45">{t("The language of this app on this device.")}</p>
                  <select
                    id="app-language"
                    className={`${input} mt-3 sm:w-auto`}
                    value={locale}
                    onChange={(e) => setLocale(e.target.value as Locale)}
                  >
                    {LOCALES.map((l) => (
                      <option key={l} value={l}>
                        {LOCALE_META[l].nativeName}
                      </option>
                    ))}
                  </select>
                </div>
              </Card>
              <Card>
                <div className="px-4 py-3.5">
                  {/* A plain heading, not <legend>: a legend sits ON the card's top border. */}
                  <div id="close-behavior-title" className="text-[13px] font-medium text-fog">
                    {t("When you close the window while browsers are running")}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-fog/45">
                    {t(
                      "The app keeps each browser's licence renewed. If it quits, a browser on the free plan stops by itself within a few minutes.",
                    )}
                  </p>
                  <div className="mt-3 space-y-1.5" role="radiogroup" aria-labelledby="close-behavior-title">
                    {(
                      [
                        ["ask", t("Ask me each time")],
                        ["tray", t("Keep running in the tray")],
                        ["quit", t("Close the browsers and quit")],
                      ] as const
                    ).map(([v, text]) => (
                      <label key={v} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-fog/80 hover:bg-elevate">
                        <input
                          type="radio"
                          name="close-behavior"
                          className="accent-[#38e0d6]"
                          checked={(settings.closeBehavior ?? "ask") === v}
                          onChange={() => onSaveSettings({ closeBehavior: v })}
                        />
                        {text}
                      </label>
                    ))}
                  </div>
                </div>
              </Card>
              </div>
            )}

            {section === "browser" && (
              <div className="space-y-4">
                <Card>
                  <Row
                    title={custom ? t("Custom binary") : t("Automatic")}
                    hint={
                      custom
                        ? t("Every profile launches this file, whatever version it asks for.")
                        : t("Each profile's browser version is downloaded on first use and checked against its SHA-256.")
                    }
                  >
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                        (custom ? "bg-warn/10 text-warn" : "bg-accent/10 text-accent")
                      }
                    >
                      {custom ? t("Override") : t("Managed")}
                    </span>
                  </Row>
                  <div className="px-4 py-3.5">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-fog/40">
                      {custom ? t("Path") : t("Fallback when offline")}
                    </div>
                    <div className="mt-1.5 break-all rounded-lg bg-ink/70 px-3 py-2 font-mono text-[11px] text-fog/60">
                      {custom || binary || t("(none found)")}
                    </div>
                    <p className="mt-2 text-xs text-fog/40">
                      {tRich("Point at a local {exe} to test your own build. The {env} environment variable does the same.", {
                        exe: <span className="font-mono">{exe}</span>,
                        env: <span className="font-mono">CLEARCOTE_BINARY</span>,
                      })}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button className={btn} onClick={onPick}>
                        {t("Choose {exe}…", { exe })}
                      </button>
                      {custom && (
                        <button className={btn} onClick={() => onSaveSettings({ binaryPath: undefined })}>
                          {t("Use automatic")}
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
                <Card>
                  <Row
                    title={t("Block certificates Chrome has revoked")}
                    hint={
                      <>
                        {tRich(
                          "Gives every profile Chrome's revocation list, which the browser never downloads by itself, so it refuses the certificates Google has revoked or distrusted, as Chrome does. The list comes from {host}, directly from this PC rather than through a profile's proxy, and is refreshed every 6 hours. The first tab waits on a blank page for a few seconds until the list is active, then opens the start page.",
                          { host: <span className="font-mono">update.googleapis.com</span> },
                        )}
                      </>
                    }
                  >
                    <Toggle
                      label={t("Block certificates Chrome has revoked")}
                      checked={settings.crlset !== false}
                      onChange={(v) => onSaveSettings({ crlset: v })}
                    />
                  </Row>
                  {settings.crlset === false && (
                    <div className="px-4 py-3 text-[11px] text-warn">
                      {t(
                        "With this off, profiles accept certificates Chrome has revoked, such as those of a certificate authority whose keys were compromised.",
                      )}
                    </div>
                  )}
                </Card>
              </div>
            )}

            {section === "license" && (
              <div className="space-y-4">
                {api.license.loginStart && (
                  <Card>
                    <div className="px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="min-w-[220px] flex-1">
                          <div className="text-[13px] font-medium text-fog">{t("Use my Clearcote account")}</div>
                          <p className="mt-1 text-[11px] leading-relaxed text-fog/55">
                            {t(
                              "Sign in on clearcotelabs.com and approve. The key of the plan you pay for (or your free one) is filled in here. Nothing to copy.",
                            )}
                          </p>
                        </div>
                        <button
                          className={btn}
                          onClick={() => void useAccount()}
                          disabled={login?.phase === "starting" || login?.phase === "waiting"}
                        >
                          {login?.phase === "starting" ? t("Starting…") : t("Use my account ↗")}
                        </button>
                      </div>
                      {login?.phase === "waiting" && (
                        <div className="mt-3 rounded-lg bg-elevate px-3 py-2.5 text-xs text-fog/75" role="status">
                          {tRich("Approve it in the tab that opened. Check that it shows {code}. <a>Open the sign-in page</a>", {
                            code: <span className="font-mono font-semibold text-fog">{login.userCode}</span>,
                            a: (s) => (
                              <a className="text-accent underline" href={login.uri} target="_blank" rel="noreferrer">
                                {s}
                              </a>
                            ),
                          })}
                        </div>
                      )}
                      {login?.phase === "done" && (
                        <div className="mt-3 rounded-lg bg-ok/10 px-3 py-2 text-xs text-ok" role="status">
                          {login.plan
                            ? login.account
                              ? t("✓ Key saved ({plan} plan) from {account}.", { plan: login.plan, account: login.account })
                              : t("✓ Key saved ({plan} plan).", { plan: login.plan })
                            : login.account
                              ? t("✓ Key saved from {account}.", { account: login.account })
                              : t("✓ Key saved.")}
                        </div>
                      )}
                      {login?.phase === "error" && (
                        <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">✕ {login.error}</div>
                      )}
                    </div>
                  </Card>
                )}
                <Card>
                  <div className="px-4 py-3.5">
                    <label htmlFor="lic-key" className="text-[13px] font-medium text-fog">
                      {t("Licence key")}
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <div className="relative min-w-[220px] flex-1">
                        <input
                          id="lic-key"
                          className={`${input} pr-14 font-mono`}
                          type={reveal ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          value={key}
                          onChange={(e) => {
                            setKey(e.target.value);
                            setStatus(null);
                          }}
                          onKeyDown={(e) => e.key === "Enter" && dirty && void saveKey()}
                          placeholder="cc_lic_…"
                        />
                        <button
                          type="button"
                          className="absolute inset-y-0 right-2 my-auto h-6 rounded px-1.5 text-[11px] text-fog/45 hover:text-fog"
                          onClick={() => setReveal((v) => !v)}
                          aria-label={reveal ? t("Hide key") : t("Show key")}
                        >
                          {reveal ? t("Hide") : t("Show")}
                        </button>
                      </div>
                      <button className={btn} onClick={saveKey} disabled={!dirty}>
                        {t("Save")}
                      </button>
                      <button className={btn} onClick={() => checkKey()} disabled={checking || !key.trim()}>
                        {checking ? t("Checking…") : t("Check")}
                      </button>
                    </div>
                    {dirty && <p className="mt-2 text-[11px] text-warn">{t("Not saved yet — press Save or Enter.")}</p>}
                    {status && (
                      <div
                        className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                          status.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"
                        }`}
                      >
                        {status.ok && status.busy ? (
                          <>{t("✓ Valid — every browser slot is in use right now, so the check could not take one.")}</>
                        ) : status.ok ? (
                          <>
                            {status.plan ? t("✓ Valid — {plan} plan", { plan: status.plan }) : t("✓ Valid")}
                            {typeof status.limit === "number"
                              ? " · " +
                                (status.limit === 0
                                  ? t("{used}/unlimited browsers in use", { used: status.used ?? 0 })
                                  : t("{used}/{limit} browsers in use", { used: status.used ?? 0, limit: status.limit }))
                              : ""}
                          </>
                        ) : (
                          <>✕ {status.error || t("Invalid licence.")}</>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
                <Card>
                  <Row
                    title={t("No key yet?")}
                    hint={t(
                      "A free key runs the same licensed build, one browser at a time. Sign in with GitHub, open Licenses and click Get it free. It lasts 30 days and renews for free.",
                    )}
                  >
                    <button className={btn} onClick={() => void api.openExternal(FREE_KEY_URL)}>
                      {t("Get a free key ↗")}
                    </button>
                  </Row>
                </Card>
                <Card>
                  <Row
                    title={t("With a key")}
                    hint={t(
                      "Profiles launch the licence-gated browser (downloaded and SHA-256 verified), and each running browser holds one of your plan's slots. The free plan always runs the latest build.",
                    )}
                  />
                  <Row
                    title={t("Without a key")}
                    hint={t("Profiles launch the open build, and the app never contacts the licence service.")}
                  />
                </Card>
                <p className="text-[11px] text-fog/35">
                  {t(
                    "A saved key is checked straight away. The check briefly takes one browser slot, so while every slot is in use it can only confirm the key is valid.",
                  )}
                </p>
              </div>
            )}

            {section === "cloud" && (
              <div className="space-y-4">
                <Card>
                  <div className="px-4 py-3.5">
                    <label htmlFor="cloud-key" className="text-[13px] font-medium text-fog">
                      {t("API key")}
                    </label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <div className="relative min-w-[220px] flex-1">
                        <input
                          id="cloud-key"
                          className={`${input} pr-14 font-mono`}
                          type={revealApi ? "text" : "password"}
                          autoComplete="off"
                          spellCheck={false}
                          value={apiKey}
                          onChange={(e) => {
                            setApiKey(e.target.value);
                            setAccount(null);
                          }}
                          onKeyDown={(e) => e.key === "Enter" && apiDirty && void saveApiKey()}
                          placeholder="cc_live_…"
                        />
                        <button
                          type="button"
                          className="absolute inset-y-0 right-2 my-auto h-6 rounded px-1.5 text-[11px] text-fog/45 hover:text-fog"
                          onClick={() => setRevealApi((v) => !v)}
                          aria-label={revealApi ? t("Hide API key") : t("Show API key")}
                        >
                          {revealApi ? t("Hide") : t("Show")}
                        </button>
                      </div>
                      <button className={btn} onClick={saveApiKey} disabled={!apiDirty}>
                        {t("Save")}
                      </button>
                      <button className={btn} onClick={() => checkApiKey()} disabled={checkingApi || !apiKey.trim()}>
                        {checkingApi ? t("Checking…") : t("Check")}
                      </button>
                    </div>
                    {apiDirty && <p className="mt-2 text-[11px] text-warn">{t("Not saved yet — press Save or Enter.")}</p>}
                    {apiKeyLooksWrong && (
                      <p className="mt-2 text-[11px] text-warn">
                        {t("API keys start with cc_live_. A licence key (cc_lic_…) belongs under Licence.")}
                      </p>
                    )}
                    {account && (
                      <div
                        role="status"
                        className={`mt-3 rounded-lg px-3 py-2 text-xs ${account.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"}`}
                      >
                        {account.ok ? (
                          <>{t("✓ Accepted · balance €{amount}", { amount: (account.balanceEur ?? 0).toFixed(2) })}</>
                        ) : (
                          <>✕ {account.error || t("The key could not be checked.")}</>
                        )}
                      </div>
                    )}
                  </div>
                </Card>
                <Card>
                  <Row
                    title={t("No key yet?")}
                    hint={t(
                      "Create one on the dashboard's API keys page. It is not the licence key: the licence runs browsers on this PC, the API key pays for browsers on Clearcote's servers.",
                    )}
                  >
                    <button className={btn} onClick={() => void api.openExternal(API_KEYS_URL)}>
                      {t("Create an API key ↗")}
                    </button>
                  </Row>
                  <Row
                    title={t("Balance")}
                    hint={t("Cloud browsers are billed per GB of traffic from your Clearcote balance. Prices are on the dashboard.")}
                  >
                    <button className={btn} onClick={() => void api.openExternal(TOPUP_URL)}>
                      {t("Top up ↗")}
                    </button>
                  </Row>
                </Card>
                <Card>
                  <Row
                    title={t("Running a profile in the cloud")}
                    hint={t(
                      "Its card's Cloud button starts it on Clearcote's servers and opens a window here where you watch and drive it. Its seed gives it the same device every time, the included IP stays the same for up to a day, and its cookies are kept between cloud sessions. Change where its traffic leaves, or set a traffic cap, under Cloud in the profile's editor.",
                    )}
                  />
                  <Row
                    title={t("When it stops")}
                    hint={t(
                      "When you press Stop, when you quit the app, or after 30 minutes with nobody watching or typing. Closing its window, or keeping the app in the tray, does not stop it.",
                    )}
                  />
                </Card>
                <p className="text-[11px] text-fog/35">
                  {t(
                    "The key is sent only to clearcotelabs.com, and only when a cloud browser is started, checked or followed.",
                  )}
                </p>
              </div>
            )}

            {section === "updates" && (
              <Card>
                <Row
                  title={t("Check for updates when the app starts")}
                  hint={
                    <>
                      {tRich(
                        "Each time the app starts, it asks {host} whether a newer release exists and suggests upgrading. This build is unsigned, so nothing is installed behind your back — you download and run the installer yourself, and its checksum is verified first.",
                        { host: <span className="font-mono">api.github.com</span> },
                      )}
                    </>
                  }
                >
                  <Toggle
                    label={t("Check for updates when the app starts")}
                    checked={settings.updateCheck !== false}
                    onChange={(v) => onSaveSettings({ updateCheck: v })}
                  />
                </Row>
                <Row
                  title={t("Check now")}
                  hint={
                    updMsg ??
                    (settings.lastUpdateCheck
                      ? t("Last checked {when}.", { when: new Date(settings.lastUpdateCheck).toLocaleString() })
                      : t("Not checked yet."))
                  }
                >
                  <button className={btn} onClick={checkNow} disabled={updChecking}>
                    {updChecking ? t("Checking…") : t("Check now")}
                  </button>
                </Row>
                {settings.updateCheck === false && (
                  <div className="px-4 py-3 text-[11px] text-warn">
                    {t("The browser engine updates itself, but with this off the app can sit on already-fixed bugs.")}
                  </div>
                )}
              </Card>
            )}

            {section === "storage" && (
              <StorageSection
                autoPrune={settings.autoPruneBuilds !== false}
                onAutoPrune={(v) => onSaveSettings({ autoPruneBuilds: v })}
              />
            )}
          </div>
        </div>

        <DialogFooter className="justify-end">
          <span className="mr-auto text-[11px] text-fog/35">
            {t("Changes save as you make them — the licence key saves with Save.")}
          </span>
          <button className="rounded-lg bg-sheen px-4 py-1.5 text-sm font-semibold text-[#07080a]" onClick={onClose}>
            {t("Done")}
          </button>
        </DialogFooter>
    </Dialog>
  );
}
