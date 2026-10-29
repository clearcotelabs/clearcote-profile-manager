"use client";

// The web version's frame around the app. Until this computer is paired with the Clearcote Helper,
// the app runs as a preview with example profiles (webPreview.ts), under a bar that says so. Anything
// that needs the computer opens the connect window: download the helper, pair once, done. Then the
// app switches to the helper and the profiles made in the preview move to the computer.
// In the desktop app (and the design mock) it renders its children straight away.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { isWeb, PROFILES_KEY } from "@/lib/ipc";
import {
  connectCode,
  helper,
  importToHelper,
  type PairRequest,
  type Probe,
} from "@/lib/helperBridge";
import {
  NEED_HELPER_EVENT,
  forgetPreviewProfiles,
  previewProfiles,
} from "@/lib/webPreview";
import {
  RELEASES_FALLBACK,
  bestHelperRelease,
  builtHelperRelease,
  detectArch,
  downloadFor,
  fetchHelperRelease,
  type HelperArch,
  type HelperRelease,
} from "@/lib/helperRelease";
import { LogoMark } from "./LogoMark";
import { t, tRich, tx, useLocale } from "@/lib/i18n";

const SOURCE =
  "https://github.com/clearcotelabs/clearcote-profile-manager/tree/main/helper";

type Mode = "preview" | "live";

type Phase =
  | { k: "looking" }
  | { k: "missing"; blocked: boolean }
  | { k: "found"; probe: Probe }
  | { k: "pairing"; probe: Probe; req: PairRequest }
  | { k: "refused"; probe: Probe; why: "denied" | "expired" };

function osName(): "Windows" | "macOS" | "Linux" {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua) && !/Android/.test(ua)) return "Linux";
  return "Windows";
}

/** Chrome's "local network access" permission, when the browser has one: "denied" means the page
 *  can never reach the helper until the person changes it in site settings. */
async function localNetworkDenied(): Promise<boolean> {
  for (const name of ["local-network-access", "loopback-network"]) {
    try {
      const s = await navigator.permissions.query({
        name: name as PermissionName,
      });
      return s.state === "denied";
    } catch {
      /* not a permission this browser knows */
    }
  }
  return false;
}

function browserName(): string {
  const ua = navigator.userAgent;
  const b = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "A browser";
  return `${b} on ${osName()}`;
}

export default function HelperGate({
  children,
}: {
  children: React.ReactNode;
}) {
  useLocale();
  if (!isWeb) return <>{children}</>;
  return <WebShell>{children}</WebShell>;
}

function WebShell({ children }: { children: React.ReactNode }) {
  useLocale();
  // Always the preview first: it is what the prerendered page (and a search engine) shows, so the
  // first render matches it. A saved pairing is then checked, and the app switches when it holds.
  const [mode, setMode] = useState<Mode>("preview");
  const [checking, setChecking] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const [moved, setMoved] = useState<number | null>(null);
  const [checked, setChecked] = useState(false);
  // The cloud viewer's own tab: it only means something connected, so no preview there.
  const viewer = /\/cloud(\.html)?$/.test(usePathname() ?? "");
  helper.live = mode === "live";

  useEffect(() => {
    if (!helper.load()) return setChecked(true);
    setChecking(true);
    void helper.probe().then((p) => {
      if (p?.paired) {
        helper.use(p.port);
        setMode("live");
      }
      setChecking(false);
      setChecked(true);
    });
  }, []);

  useEffect(() => {
    const open = (e: Event) =>
      setWhy(String((e as CustomEvent).detail || tx("use this computer")));
    window.addEventListener(NEED_HELPER_EVENT, open);
    helper.onLost = () => {
      setLost(true);
      setMode("preview");
    };
    return () => {
      window.removeEventListener(NEED_HELPER_EVENT, open);
      helper.onLost = null;
    };
  }, []);

  const paired = useCallback(async (reason: string) => {
    // Profiles made in the preview go to the computer, so nothing tried here is lost.
    const list = previewProfiles(PROFILES_KEY);
    if (list.length) {
      try {
        const n = await importToHelper(list);
        // Only when all of them made it: anything the helper skipped stays in the preview.
        if (n === list.length) forgetPreviewProfiles(PROFILES_KEY, list);
        if (n > 0) setMoved(n);
      } catch {
        /* they stay in the preview; nothing is lost */
      }
    }
    helper.justPaired = reason;
    setWhy(null);
    setLost(false);
    setMode("live");
  }, []);

  if (viewer) {
    if (mode === "live") return <>{children}</>;
    return (
      <main className="flex min-h-screen items-center justify-center bg-ink px-6 text-center text-sm text-fog/70">
        {checked ? t("This cloud browser opens from the Clearcote profile manager, on a computer connected to it.") : t("Connecting to the Clearcote helper…")}
      </main>
    );
  }

  return (
    <>
      {mode === "preview" && (
        <div className="sticky top-0 z-40 border-b border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm">
            <span className="flex-1 basis-[280px] text-fog/80">
              {checking ? (
                <>{t("Connecting to the Clearcote helper on this computer…")}</>
              ) : lost ? (
                <>
                  {t(
                    "The Clearcote helper stopped answering, so this is the preview again. Start it, then connect.",
                  )}
                </>
              ) : (
                <>
                  {tRich(
                    "<b>Preview with example profiles.</b> Connect this computer to launch real browsers. Your profiles stay on your computer.",
                    {
                      b: (s) => (
                        <strong className="font-semibold text-fog">{s}</strong>
                      ),
                    },
                  )}
                </>
              )}
            </span>
            <button
              type="button"
              onClick={() => setWhy(tx("launch your profiles"))}
              className="min-h-[40px] rounded-xl bg-fog px-4 text-sm font-semibold text-ink hover:opacity-90"
            >
              {t("Connect this computer")}
            </button>
          </div>
        </div>
      )}
      {moved !== null && (
        <div role="status" className="mx-auto mt-3 max-w-6xl px-4">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok">
            <span>
              {moved === 1
                ? t(
                    "Connected. 1 profile you made in the preview moved to this computer.",
                  )
                : t(
                    "Connected. {n} profiles you made in the preview moved to this computer.",
                    { n: moved },
                  )}
            </span>
            <button
              type="button"
              className="min-h-[32px] px-2 text-xs underline"
              onClick={() => setMoved(null)}
            >
              {t("Dismiss")}
            </button>
          </div>
        </div>
      )}
      {/* A new key remounts the app, so it loads again from whichever side it now talks to. */}
      <div key={mode}>{children}</div>
      {why !== null && (
        <ConnectDialog
          why={why}
          onClose={() => setWhy(null)}
          onPaired={() => void paired(why)}
        />
      )}
    </>
  );
}

function ConnectDialog({
  why,
  onClose,
  onPaired,
}: {
  why: string;
  onClose: () => void;
  onPaired: () => void;
}) {
  useLocale();
  const [phase, setPhase] = useState<Phase>({ k: "looking" });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // For `clearcote connect CODE`: shown while there is no helper. A helper that then appears was most
  // likely started with it, so the page pairs straight away, sending the code (helper/auth.ts allowCode).
  const [code] = useState(connectCode);
  const codeShown = useRef(false);

  const look = useCallback(async () => {
    const p = await helper.probe();
    if (!p) {
      codeShown.current = true;
      return setPhase({ k: "missing", blocked: await localNetworkDenied() });
    }
    if (p.paired) {
      helper.use(p.port);
      return onPaired();
    }
    if (helper.conn) helper.forget(); // a token it no longer knows
    if (codeShown.current) return void pair(p, code);
    setPhase({ k: "found", probe: p });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onPaired, code]);

  useEffect(() => {
    void look();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep looking while there is no helper (the person is installing it).
  useEffect(() => {
    if (phase.k !== "missing") return;
    timer.current = setTimeout(() => void look(), 2500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [phase, look]);

  // While a pairing request is open, ask the helper how it went.
  useEffect(() => {
    if (phase.k !== "pairing") return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const s = await helper.pairStatus(phase.probe.port, phase.req);
        if (stop) return;
        if (s === "approved") {
          helper.use(phase.probe.port);
          return onPaired();
        }
        if (s === "denied" || s === "expired")
          return setPhase({ k: "refused", probe: phase.probe, why: s });
      } catch {
        /* the helper may be restarting */
      }
      setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [phase, onPaired]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  async function pair(probe: Probe, withCode?: string) {
    try {
      const req = await helper.startPairing(
        probe.port,
        browserName(),
        withCode,
      );
      setPhase({ k: "pairing", probe, req });
    } catch {
      setPhase({ k: "looking" });
      void look();
    }
  }

  return (
    <div
      // items-start + the dialog's my-auto: centred when it fits, and when it is taller than the screen it
      // starts at the top and scrolls (items-center pushed its top, close button included, out of reach).
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-title"
        onClick={(e) => e.stopPropagation()}
        className="relative my-auto w-full max-w-[560px] rounded-2xl border border-line bg-surface p-5 text-fog shadow-xl sm:p-8"
      >
        <button
          type="button"
          aria-label={t("Close")}
          onClick={onClose}
          className="absolute right-3 top-3 flex h-10 w-10 items-center justify-center rounded-lg text-fog/60 hover:bg-elevate hover:text-fog"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="mb-6 flex items-center gap-2.5 text-[15px] font-semibold">
          <LogoMark />
          <span>
            Clear<span className="text-fog/60">cote</span> Profile Manager
          </span>
        </div>

        <h1 id="connect-title" className="mb-4 pr-8 text-xl font-semibold">
          {t("To {why}, connect this computer", { why: t(why) })}
        </h1>

        {phase.k === "looking" && (
          <p className="text-sm text-fog/70">
            {t("Looking for the Clearcote helper on this computer…")}
          </p>
        )}

        {phase.k === "missing" && (
          <Missing blocked={phase.blocked} code={code} />
        )}

        {phase.k === "found" && (
          <section className="space-y-4">
            <p className="text-sm leading-relaxed text-fog/75">
              {t(
                "The helper (version {version}) is running. Pair once, and this page can start your Clearcote browsers. The helper will open a page where you approve it.",
                { version: phase.probe.version },
              )}
            </p>
            <button
              type="button"
              onClick={() => void pair(phase.probe)}
              className="min-h-[44px] rounded-xl bg-fog px-5 text-sm font-semibold text-ink hover:opacity-90"
            >
              {t("Pair this browser")}
            </button>
          </section>
        )}

        {phase.k === "pairing" && (
          <section className="space-y-4">
            <p className="text-sm leading-relaxed text-fog/75">
              {tRich(
                "A tab from the helper (127.0.0.1) just opened. Check that it shows this code, then press <b>Codes match: approve</b>.",
                { b: (s) => <strong>{s}</strong> },
              )}
            </p>
            <div className="rounded-xl border border-line bg-elevate p-5">
              <div className="text-xs font-semibold uppercase tracking-wider text-fog/60">
                {t("Pairing code")}
              </div>
              <div className="mt-1 font-mono text-4xl font-semibold tracking-[0.08em]">
                {phase.req.code}
              </div>
            </div>
            <p className="text-xs text-fog/60">
              {tRich(
                "No tab? <a>Open the approval page</a>. The request expires in two minutes.",
                {
                  a: (s) => (
                    <a
                      className="text-accent underline"
                      href={phase.req.approveUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {s}
                    </a>
                  ),
                },
              )}
            </p>
          </section>
        )}

        {phase.k === "refused" && (
          <section className="space-y-4">
            <p className="text-sm text-fog/75">
              {phase.why === "denied"
                ? t("Pairing was denied. Nothing was paired.")
                : t("The request expired. Nothing was paired.")}
            </p>
            <button
              type="button"
              onClick={() => void pair(phase.probe)}
              className="min-h-[44px] rounded-xl bg-fog px-5 text-sm font-semibold text-ink hover:opacity-90"
            >
              {t("Try again")}
            </button>
          </section>
        )}

        <div className="mt-6 border-t border-line pt-4 text-right">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] px-2 text-sm text-fog/70 hover:text-fog"
          >
            {t("Keep looking around")}
          </button>
        </div>
      </div>
    </div>
  );
}

const WAY_KEY = "clearcote.connectWay";

/** The SDK's `clearcote connect` unless this browser picked the download before. */
function savedWay(): "download" | "sdk" {
  try {
    return localStorage.getItem(WAY_KEY) === "download" ? "download" : "sdk";
  } catch {
    return "sdk";
  }
}

function Missing({ blocked, code }: { blocked: boolean; code: string }) {
  useLocale();
  const [way, setWay] = useState<"download" | "sdk">("sdk");
  useEffect(() => setWay(savedWay()), []);
  const pick = (w: "download" | "sdk") => {
    setWay(w);
    try {
      localStorage.setItem(WAY_KEY, w);
    } catch {
      /* private mode */
    }
  };
  const tab = (w: "download" | "sdk", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={way === w}
      onClick={() => pick(w)}
      className={`min-h-[40px] flex-1 rounded-lg px-3 text-sm font-semibold ${way === w ? "bg-fog text-ink" : "text-fog/70 hover:text-fog"}`}
    >
      {label}
    </button>
  );
  return (
    <section className="space-y-5">
      <p className="text-sm leading-relaxed text-fog/75">
        {t(
          "Your profiles stay on your computer. To open them from this page, Clearcote needs a small helper running there. It is open source and you can rebuild it yourself and check it byte for byte.",
        )}
      </p>
      {blocked && (
        <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
          {t(
            "This browser is blocking the page from reaching apps on this computer. Allow “Local network access” for this site (the icon left of the address), then reload.",
          )}
        </p>
      )}
      <div
        role="tablist"
        aria-label={t("How to start the helper")}
        className="flex gap-1 rounded-xl border border-line bg-elevate p-1"
      >
        {tab("sdk", t("I use the Clearcote SDK"))}
        {tab("download", t("Download the helper"))}
      </div>
      {way === "download" ? <DownloadSteps /> : <SdkSteps code={code} />}
      <p className="text-xs text-fog/50">{t("Looking for the helper…")}</p>
    </section>
  );
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-ink px-3 py-2">
      {/* Wraps at the spaces on a phone, so the code at the end is never scrolled out of sight. */}
      <code className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-[13px] text-fog [overflow-wrap:anywhere]">
        {text}
      </code>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            () => {},
          )
        }
        className="min-h-[32px] flex-none rounded-md px-2 text-xs font-semibold text-fog/70 hover:bg-elevate hover:text-fog"
      >
        {copied ? t("Copied") : t("Copy")}
      </button>
    </div>
  );
}

function SdkSteps({ code }: { code: string }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="leading-relaxed text-fog/75">
        {t(
          "Run this in a terminal on this computer, with Node.js or Python. It downloads the same helper (checked against its SHA-256) and starts it. This tab connects by itself: the code is how the helper knows it is you.",
        )}
      </p>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-fog/60">
          Node.js
        </div>
        <Copyable text={`npx clearcote@latest connect ${code}`} />
        <div className="text-xs text-fog/60">
          {tRich(
            "Nothing to install first: npx fetches the SDK. Needs Node.js 20 or newer (<a>nodejs.org</a>).",
            {
              a: (s) => (
                <a
                  className="text-accent underline"
                  href="https://nodejs.org/"
                  target="_blank"
                  rel="noreferrer"
                >
                  {s}
                </a>
              ),
            },
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-semibold uppercase tracking-wider text-fog/60">
          Python
        </div>
        <div className="text-xs text-fog/60">
          {t("1. Install or update the SDK (Python 3.8 or newer):")}
        </div>
        <Copyable text="pip install -U clearcote" />
        <div className="text-xs text-fog/60">{t("2. Start the helper:")}</div>
        <Copyable text={`clearcote connect ${code}`} />
      </div>
      <p className="text-xs text-fog/60">
        {t(
          "Keep the terminal open while you use the profile manager. Ctrl+C closes the helper and its browsers.",
        )}
      </p>
    </div>
  );
}

function DownloadSteps() {
  const os = osName();
  // The release this page was built with works at once; GitHub's answer only swaps in a newer one.
  const [rel, setRel] = useState<HelperRelease | null>(() =>
    builtHelperRelease(),
  );
  const [arch, setArch] = useState<HelperArch | undefined>(undefined);
  useEffect(() => {
    void fetchHelperRelease().then((api) => setRel(bestHelperRelease(api)));
    void detectArch().then(setArch);
  }, []);
  const mine = rel ? downloadFor(rel, os, arch) : null;
  return (
    <ol className="space-y-4 text-sm">
      <li className="flex gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-fog text-xs font-semibold text-ink">
          1
        </span>
        <div className="space-y-2">
          <div className="pt-1 font-semibold">
            {t("Download the helper for {os}", { os })}
          </div>
          <a
            href={mine?.url ?? rel?.page ?? RELEASES_FALLBACK}
            target={mine ? undefined : "_blank"}
            rel="noreferrer"
            className="inline-flex min-h-[44px] items-center rounded-xl bg-fog px-5 font-semibold text-ink hover:opacity-90"
          >
            {mine
              ? mine.sizeMB
                ? t("Download for {label} ({size} MB)", {
                    label: t(mine.label),
                    size: mine.sizeMB,
                  })
                : t("Download for {label}", { label: t(mine.label) })
              : t("Get Clearcote Helper")}
          </a>
          <div className="text-xs text-fog/60">
            {rel ? (
              <>
                {t("Version {version}.", { version: rel.version })}{" "}
                <a
                  className="text-accent underline"
                  href={rel.page}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("Other systems and checksums")}
                </a>
                {" · "}
              </>
            ) : (
              <>{t("Pick the file for {os} on the releases page.", { os })} </>
            )}
            <a
              className="text-accent underline"
              href={SOURCE}
              target="_blank"
              rel="noreferrer"
            >
              {t("Read its source and how to verify it")}
            </a>
            .
          </div>
        </div>
      </li>
      <li className="flex gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-elevate text-xs font-semibold">
          2
        </span>
        <div className="pt-1">
          <div className="font-semibold">{t("Unzip it and start it")}</div>
          <div className="text-fog/65">
            {os === "Windows"
              ? t(
                  "Double-click “Clearcote Helper.cmd”. It runs as an icon next to the clock; right-click it to quit.",
                )
              : os === "macOS"
                ? t(
                    "Right-click “Clearcote Helper.command”, then Open. Keep its window open.",
                  )
                : t("Run ./clearcote-helper.sh. Keep its window open.")}
          </div>
        </div>
      </li>
      <li className="flex gap-3">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-elevate text-xs font-semibold">
          3
        </span>
        <div className="pt-1">
          <div className="font-semibold">{t("Come back to this tab")}</div>
          <div className="text-fog/65">
            {t(
              "It finds the helper by itself. Your browser may ask to let this site reach devices on your local network: allow it, that is the helper.",
            )}
          </div>
        </div>
      </li>
    </ol>
  );
}
