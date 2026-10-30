"use client";

// Jet setup as a checklist: Python, Jet, model key. Each line says what is wrong and has the one button that
// fixes it (Download Python, Install Jet, Check and save the key), so nobody needs a terminal. Shown in
// Settings → Tasks and, until everything is ready, at the top of Run a task. The checks live in
// electron/jetsetup.ts.

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, type JetStatus, type Settings } from "@/lib/ipc";
import { t } from "@/lib/i18n";

const PYTHON_URL = "https://www.python.org/downloads/";
const KEY_URL = "https://console.typesafe.ai";

const input =
  "w-full min-w-0 rounded-lg bg-ink/70 border border-line px-3 py-1.5 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40 font-mono";
const btn =
  "shrink-0 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate transition disabled:opacity-40 disabled:hover:bg-transparent";
const btnPrimary = "shrink-0 rounded-lg bg-sheen px-3 py-1.5 text-xs font-semibold text-[#07080a] disabled:opacity-40";

type Mark = "ok" | "todo" | "busy" | "off";

function Dot({ mark }: { mark: Mark }) {
  if (mark === "busy") return <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden />;
  const cls = mark === "ok" ? "bg-ok/15 text-ok" : mark === "todo" ? "bg-warn/15 text-warn" : "bg-line text-fog/30";
  return (
    <span className={"mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold " + cls} aria-hidden>
      {mark === "ok" ? "✓" : mark === "todo" ? "!" : "·"}
    </span>
  );
}

function Row({ mark, title, children, data }: { mark: Mark; title: React.ReactNode; children?: React.ReactNode; data: string }) {
  return (
    <li className="flex gap-2.5 px-3.5 py-3" data-jet-row={data} data-jet-mark={mark}>
      <Dot mark={mark} />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-fog">{title}</div>
        {children && <div className="mt-1.5 text-xs leading-relaxed text-fog/55">{children}</div>}
      </div>
    </li>
  );
}

export default function JetSetup({
  settings,
  onSaveSettings,
  onReady,
  compact = false,
}: {
  settings: Settings;
  onSaveSettings: (patch: Partial<Settings>) => Promise<void> | void;
  /** Told whenever the answer to "can a task run?" changes. */
  onReady?: (ready: boolean) => void;
  /** In Run a task: when everything is ready, one line instead of the list. */
  compact?: boolean;
}) {
  const setup = api.jetSetup;
  const keyId = useId();
  const [status, setStatus] = useState<JetStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [editKey, setEditKey] = useState(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const saveRef = useRef(onSaveSettings);
  saveRef.current = onSaveSettings;

  const apply = useCallback((s: JetStatus) => {
    setStatus(s);
    onReadyRef.current?.(s.ready);
    // The app found Jet under a Python that is not on PATH: keep the renderer's settings in step.
    if (s.fixedCommand) void saveRef.current({ jetCommand: s.fixedCommand });
  }, []);

  const refresh = useCallback(async () => {
    if (!setup) return;
    setChecking(true);
    setStatusError(null);
    try {
      apply(await setup.status());
    } catch (e) {
      setStatusError(String((e as Error)?.message || e));
    } finally {
      setChecking(false);
    }
  }, [setup, apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!setup) return null;

  async function install() {
    if (!setup) return;
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await setup.install();
      if (r.ok) apply(r.status);
      else setInstallError(r.error);
    } catch (e) {
      setInstallError(String((e as Error)?.message || e));
    } finally {
      setInstalling(false);
    }
  }

  async function saveKey() {
    if (!setup || !key.trim()) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const r = await setup.checkKey(key.trim());
      if (r.ok) {
        await onSaveSettings({ jetApiKey: key.trim() });
        setKey("");
        setEditKey(false);
        if (status) apply({ ...status, key: r, ready: status.jet.ok });
      } else {
        setKeyError(
          r.reason === "rejected"
            ? t("This key was not accepted. Copy it again from the console: the whole key, no spaces.")
            : r.detail || t("The key could not be checked. Try again in a moment."),
        );
      }
    } catch (e) {
      setKeyError(String((e as Error)?.message || e));
    } finally {
      setKeyBusy(false);
    }
  }

  if (!status && statusError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-xl border border-danger/40 bg-danger/5 px-3.5 py-3 text-xs text-danger" data-jet-setup="error">
        <span className="min-w-0 flex-1 break-words">{t("Could not check Jet: {error}", { error: statusError })}</span>
        <button className={btn} onClick={() => void refresh()} disabled={checking}>
          {checking ? t("Checking…") : t("Check again")}
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-ink/30 px-3.5 py-3 text-xs text-fog/55" data-jet-setup="checking">
        <Dot mark="busy" />
        {t("Checking whether Jet is ready on this PC…")}
      </div>
    );
  }

  const { python, jet, key: keyState } = status;
  if (compact && status.ready) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-line bg-ink/30 px-3.5 py-2.5 text-xs text-fog/60" data-jet-setup="ready">
        <Dot mark="ok" />
        <span className="flex-1">{jet.ok ? t("Jet {v} is ready.", { v: jet.version }) : null}</span>
        <button className="text-fog/45 hover:text-fog" onClick={() => void refresh()} disabled={checking}>
          {checking ? t("Checking…") : t("Check again")}
        </button>
      </div>
    );
  }

  const showKeyInput = !keyState.ok || editKey;
  return (
    <div className="rounded-xl border border-line bg-ink/30" data-jet-setup={status.ready ? "ready" : "todo"}>
      {!status.ready && (
        <div className="border-b border-line px-3.5 py-2.5 text-xs leading-relaxed text-fog/60">
          {t("Tasks are run by Jet, a free open-source helper on this PC. Set it up once:")}
        </div>
      )}
      <ol className="divide-y divide-line">
        {!jet.ok && (
          <Row
            data="python"
            mark={python ? "ok" : "todo"}
            title={python ? t("Python {v} found", { v: python.version }) : t("Install Python 3.10 or newer")}
          >
            {!python && (
              <>
                <p>{t("Jet runs on Python. On Windows, tick \"Add python.exe to PATH\" in the installer. Then come back and press Check again.")}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className={btnPrimary} onClick={() => void api.openExternal(PYTHON_URL)}>
                    {t("Download Python ↗")}
                  </button>
                  <button className={btn} onClick={() => void refresh()} disabled={checking}>
                    {checking ? t("Checking…") : t("Check again")}
                  </button>
                </div>
              </>
            )}
          </Row>
        )}

        <Row
          data="jet"
          mark={installing ? "busy" : jet.ok ? "ok" : python ? "todo" : "off"}
          title={
            jet.ok
              ? t("Jet {v} installed", { v: jet.version })
              : jet.reason === "old"
                ? t("Update Jet (this one is {v}; tasks need 0.3.0 or newer)", { v: jet.version ?? "older" })
                : t("Install Jet")
          }
        >
          {!jet.ok && (
            <>
              {installing ? (
                <p>{t("Installing Jet and the Clearcote SDK with pip. This takes a minute or two…")}</p>
              ) : (
                <p>
                  {python
                    ? t("One click: the app runs pip for you in Python {v}.", { v: python.version })
                    : t("Needs Python first.")}
                </p>
              )}
              {jet.reason === "error" && jet.detail && !installing && (
                <p className="mt-1 break-words font-mono text-[11px] text-fog/40">{jet.detail}</p>
              )}
              {installError && (
                <pre role="alert" className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-danger/10 px-2.5 py-2 font-mono text-[11px] text-danger" data-jet-install-error="1">
                  {installError}
                </pre>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                <button className={btnPrimary} onClick={() => void install()} disabled={!python || installing} data-jet-install="1">
                  {installing ? t("Installing…") : jet.reason === "old" ? t("Update Jet") : t("Install Jet")}
                </button>
                <button className={btn} onClick={() => void refresh()} disabled={checking || installing}>
                  {checking ? t("Checking…") : t("Check again")}
                </button>
              </div>
            </>
          )}
        </Row>

        <Row
          data="key"
          mark={keyBusy ? "busy" : keyState.ok ? "ok" : "todo"}
          title={
            keyState.ok
              ? keyState.source === "environment"
                ? t("Model key works (from TYPESAFE_API_KEY)")
                : t("Model key works")
              : t("Add your model key")
          }
        >
          {keyState.ok && !editKey && (
            <button className="text-fog/45 underline-offset-2 hover:text-fog hover:underline" onClick={() => setEditKey(true)}>
              {t("Use another key")}
            </button>
          )}
          {showKeyInput && (
            <>
              <p>
                {t("Jet's model picks each click the first time a task is learned, about $0.001 a task. Repeating a learned task uses no model. Create a key in the TypeSafe console and paste it here.")}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label htmlFor={keyId} className="sr-only">
                  {t("Model key")}
                </label>
                <input
                  id={keyId}
                  className={input + " max-w-xs flex-1"}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("Paste your key")}
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setKeyError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveKey();
                  }}
                  data-jet-key="1"
                />
                <button className={btnPrimary} onClick={() => void saveKey()} disabled={!key.trim() || keyBusy} data-jet-key-save="1">
                  {keyBusy ? t("Checking…") : t("Check and save")}
                </button>
                <button className={btn} onClick={() => void api.openExternal(KEY_URL)}>
                  {t("Get a key ↗")}
                </button>
                {editKey && (
                  <button className="text-fog/45 hover:text-fog" onClick={() => setEditKey(false)}>
                    {t("Cancel")}
                  </button>
                )}
              </div>
              {keyError && (
                <p role="alert" className="mt-1.5 text-danger" data-jet-key-error="1">
                  {keyError}
                </p>
              )}
              {keyState.ok === false && keyState.reason === "rejected" && !keyError && (
                <p className="mt-1.5 text-danger">{t("The saved key was not accepted. Paste a new one.")}</p>
              )}
            </>
          )}
        </Row>
      </ol>
      {status.ready && !compact && (
        <div className="flex items-center justify-between border-t border-line px-3.5 py-2 text-[11px] text-fog/45">
          <span>{t("Ready. Select profiles and choose Run a task.")}</span>
          <button className="hover:text-fog" onClick={() => void refresh()} disabled={checking}>
            {checking ? t("Checking…") : t("Check again")}
          </button>
        </div>
      )}
    </div>
  );
}
