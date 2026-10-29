"use client";

// "A new version is available." Notified, never installed behind your back: this build is unsigned,
// so an unattended install would be an unverified code path — see electron/appupdate.ts.

import { useState } from "react";
import type { UpdateInfo } from "@/lib/ipc";
import { t, tRich } from "@/lib/i18n";

const btnGhost =
  "rounded-lg border border-line px-3 py-1 text-xs font-medium text-fog/80 hover:bg-elevate transition";

export default function UpdateBanner({
  update,
  file,
  busy,
  progress,
  error,
  windows,
  macos = false,
  onDownload,
  onLater,
  onRun,
  onReveal,
  onOpenReleases,
}: {
  update: UpdateInfo;
  file: { path: string; verified: boolean } | null;
  busy: boolean;
  progress: { pct: number; seenMB: number; totalMB: number } | null;
  error: string | null;
  windows: boolean;
  /** A Mac: the download is a disk image, and Gatekeeper (not SmartScreen) is what warns. */
  macos?: boolean;
  onDownload: () => void;
  /** Hide it until the app next starts. */
  onLater: () => void;
  onRun: () => void;
  onReveal: () => void;
  onOpenReleases: () => void;
}) {
  const [why, setWhy] = useState(false);
  return (
    <div className="mt-4 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5 text-xs" role="status">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-medium text-accent">{t("Version {v} is available", { v: update.latest })}</span>
        <span className="text-fog/40">{t("you have {v}", { v: update.current })}</span>
        <span className="flex-1" />
        {!file ? (
          <>
            <button className={btnGhost} onClick={onOpenReleases}>
              {t("What's new")}
            </button>
            <button
              className="rounded-lg bg-sheen px-3 py-1 text-xs font-semibold text-[#07080a] disabled:opacity-40"
              onClick={onDownload}
              disabled={busy || !update.asset}
              title={update.asset?.name || t("No matching download — use the release page")}
            >
              {busy ? t("Downloading…") : t("Download")}
            </button>
            <button className={btnGhost} onClick={onLater} title={t("Asks again next time the app starts. Settings → Updates turns this off.")}>
              {t("Later")}
            </button>
          </>
        ) : (
          <>
            <button className="rounded-lg bg-sheen px-3 py-1 text-xs font-semibold text-[#07080a]" onClick={onRun}>
              {macos ? t("Open disk image") : t("Run installer")}
            </button>
            <button className={btnGhost} onClick={onReveal}>
              {macos ? t("Show in Finder") : t("Show in folder")}
            </button>
          </>
        )}
      </div>

      {progress && (
        <div className="mt-2">
          <div className="h-1 w-full overflow-hidden rounded bg-line">
            <div className="h-full bg-sheen transition-all" style={{ width: `${progress.pct}%` }} />
          </div>
          <p className="mt-1 tabular-nums text-[11px] text-fog/40">
            {progress.pct}% · {progress.seenMB.toFixed(1)} / {progress.totalMB.toFixed(1)} MB
          </p>
        </div>
      )}

      {file && (
        // "Downloaded" and "downloaded and verified" are different claims, so which one it is gets
        // said — in one line; the longer why is one click away rather than always on screen.
        <p className="mt-2 text-[11px] text-fog/50">
          {file.verified ? (
            <>
              {tRich("<ok>✓ Verified</ok> against the checksum published with the release.", {
                ok: (s) => <span className="text-ok">{s}</span>,
              })}{" "}
              <button className="underline decoration-dotted underline-offset-2 hover:text-fog" onClick={() => setWhy((v) => !v)}>
                {why ? t("Less") : windows ? t("Why does Windows warn?") : macos ? t("Why does macOS warn?") : t("Before you run it")}
              </button>
              {why && (
                <span className="mt-1 block text-fog/45">
                  {t("The checksum proves the file is intact; it is not a signature, and this app is not code-signed.")}
                  {windows
                    ? " " + t("Windows will warn on first run — choose More info → Run anyway.")
                    : macos
                      ? " " + t("Drag the app to Applications. macOS blocks it on first open — then choose System Settings → Privacy & Security → Open Anyway.")
                      : " " + t("An AppImage needs its executable bit set (chmod +x) before it runs.")}
                </span>
              )}
            </>
          ) : (
            <span className="text-warn">
              ⚠ {t("Downloaded, but the release published no checksums, so nothing could be verified. Check it by hand before running it.")}
            </span>
          )}
        </p>
      )}

      {error && <p className="mt-2 text-[11px] text-warn">{error}</p>}
      {!update.asset && (
        <p className="mt-2 text-[11px] text-fog/45">
          {t("No download matched this installation — pick the right one on the release page.")}
        </p>
      )}
    </div>
  );
}
