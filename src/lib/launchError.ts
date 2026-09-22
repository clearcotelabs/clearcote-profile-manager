// Turning a failed (or half-successful) launch into something a person can act on.
//
// Launch errors arrive as one string built up through several layers — "Could not obtain the
// browser: PRO download not authorized (HTTP 403): {"error":"…","code":"FREE_LATEST_ONLY"}" was a
// real one. Shown raw in a toast that disappeared after 3.5 s, nobody could read it, let alone act
// on it. This maps the known shapes to a title, a plain explanation and the ONE action that fixes
// it, and keeps the original text for "Copy details".

import { classifyExit, type ExitFacts } from "../../electron/exitreason";

export type NoticeAction =
  | { kind: "edit"; field: string }
  | { kind: "settings"; section: "license" | "browser" }
  | { kind: "retry" }
  /** One-browser plan: stop the profile that holds the slot, then launch this one. */
  | { kind: "swap"; stopId: string; stopName: string };

export interface LaunchNotice {
  tone: "error" | "warning";
  title: string;
  lines: string[];
  action?: NoticeAction;
  /** The original message, verbatim, for "Copy details". */
  raw?: string;
}

/** Pull the server's `{"error": …, "code": …}` out of a message that embeds its response body.
 *  The body can arrive truncated (the download client keeps the first 200 characters), so a JSON
 *  parse failure falls back to picking the two fields out by pattern. */
export function extractServerBody(msg: string): { error?: string; code?: string; rest: string } {
  const i = msg.indexOf("{");
  if (i < 0) return { rest: msg };
  const tail = msg.slice(i);
  const rest = msg.slice(0, i).replace(/[:\s]+$/, "");
  try {
    const j = JSON.parse(tail) as { error?: unknown; code?: unknown };
    return {
      error: typeof j.error === "string" ? j.error : undefined,
      code: typeof j.code === "string" ? j.code : undefined,
      rest,
    };
  } catch {
    const error = /"error"\s*:\s*"((?:[^"\\]|\\.)*)"?/.exec(tail)?.[1];
    const code = /"code"\s*:\s*"([A-Z0-9_]+)"/.exec(tail)?.[1];
    return error || code ? { error: error?.replace(/\\"/g, '"'), code, rest } : { rest: msg };
  }
}

const NETWORK =
  /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|Could not reach the license server|catalog fetch failed|download failed \(HTTP 5\d\d\)/i;

export function describeLaunchError(error: string | undefined, code?: string): LaunchNotice {
  const raw = (error || "").trim();
  const msg = raw.replace(/^Could not obtain the browser:\s*/i, "");
  const body = extractServerBody(msg);
  const c = (code || body.code || "").toUpperCase();
  const server = body.error;
  const http = /\(HTTP (\d{3})\)/.exec(msg)?.[1];
  const n = (x: Omit<LaunchNotice, "raw" | "tone"> & { tone?: LaunchNotice["tone"] }): LaunchNotice => ({
    tone: "error",
    raw: raw || undefined,
    ...x,
  });

  if (c === "FREE_LATEST_ONLY" || /free plan always runs the latest build/i.test(msg)) {
    const pin = /pinned to Clearcote (\S+?),/.exec(msg)?.[1];
    return n({
      title: "Pinned builds need Pro",
      lines: [
        `This profile asks for ${pin ? `build ${pin}` : "a specific build"}, and the free plan always runs the latest one.`,
        "Set its browser version to Latest to launch it.",
      ],
      action: { kind: "edit", field: "browserVersion" },
    });
  }
  if (c === "CONCURRENCY_LIMIT_EXCEEDED") {
    return n({
      title: "Your plan's browser limit is reached",
      lines: [
        server || body.rest || msg,
        "Close a browser that is using this licence — here or on another machine — and launch again.",
      ],
      action: { kind: "retry" },
    });
  }
  if (c === "DOWNLOAD_LIMIT_EXCEEDED") {
    return n({
      title: "Today's download limit is reached",
      lines: [server || msg, "Builds you already downloaded keep working."],
    });
  }
  if (c === "LICENSE_EXPIRED" || c === "LICENSE_REVOKED" || /licen[sc]e (has )?(expired|been revoked)/i.test(msg)) {
    return n({
      title: "Your licence isn't active",
      lines: [server || body.rest || msg],
      action: { kind: "settings", section: "license" },
    });
  }
  if (c === "INVALID_LICENSE" || http === "401" || /invalid licen[sc]e key|malformed licen[sc]e key/i.test(msg)) {
    return n({
      title: "Your licence key wasn't accepted",
      lines: [server || "The licence service rejected the key in Settings.", "Check it in Settings → Licence."],
      action: { kind: "settings", section: "license" },
    });
  }
  if (/is a PRO build — set a license key|No license key — cannot fetch/i.test(msg)) {
    return n({
      title: "This profile needs a licence key",
      lines: [msg.replace(/\s*\(the free build is [^)]*\)/, "").replace(/\.$/, "") + "."],
      action: { kind: "settings", section: "license" },
    });
  }
  const noMatch = /No build matches "([^"]+)"\.?\s*(.*)$/i.exec(msg);
  if (noMatch) {
    return n({
      title: `There's no build “${noMatch[1]}”`,
      lines: [noMatch[2] || "Pick a version from the list instead."],
      action: { kind: "edit", field: "browserVersion" },
    });
  }
  if (/Revision pins like/i.test(msg)) {
    return n({ title: "That version can't be pinned", lines: [msg], action: { kind: "edit", field: "browserVersion" } });
  }
  if (/SHA-256 mismatch|size mismatch|archive verified but/i.test(msg)) {
    return n({
      title: "The browser download was damaged",
      lines: ["It was discarded without being used. Launching again downloads it afresh."],
      action: { kind: "retry" },
    });
  }
  if (NETWORK.test(msg)) {
    return n({
      title: "Couldn't reach Clearcote's servers",
      lines: ["Check your internet connection, and any system proxy or firewall, then try again."],
      action: { kind: "retry" },
    });
  }
  if (/already running/i.test(msg)) {
    return n({ title: "This profile is already running", lines: [] });
  }
  if (/shader ?dialect/i.test(msg)) {
    return n({ title: "The shader dialect setting is invalid", lines: [msg], action: { kind: "edit", field: "shaderDialect" } });
  }
  if (/\bspawn\b|ENOENT|EACCES|EPERM/i.test(msg)) {
    return n({
      title: "The browser couldn't be started",
      lines: [msg, "If you set a custom browser binary in Settings, check that the file still exists."],
      action: { kind: "settings", section: "browser" },
    });
  }
  if (/only works in the desktop app/i.test(msg)) {
    return n({ tone: "warning", title: msg.replace(/\s*\(this is the browser preview\)\.?/i, "."), lines: [] });
  }
  return n({
    title: "Launch failed",
    lines: [server ? `${body.rest ? body.rest + ": " : ""}${server}` : msg || "No reason was given."],
    action: { kind: "retry" },
  });
}

/** A launch that WORKED but carries options that will silently do nothing. */
export function describeLaunchWarnings(warnings: string[]): LaunchNotice {
  return {
    tone: "warning",
    title: warnings.length === 1 ? "Launched, with a warning" : `Launched, with ${warnings.length} warnings`,
    lines: warnings,
  };
}

export function actionLabel(a: NoticeAction): string {
  if (a.kind === "retry") return "Try again";
  if (a.kind === "swap") return `Stop “${a.stopName}” and launch`;
  if (a.kind === "settings") return a.section === "license" ? "Licence settings" : "Browser settings";
  return a.field === "browserVersion" ? "Change version" : "Edit profile";
}

/**
 * On a plan at its browser limit, the most useful fix is usually "close the one that is open".
 * Offer that when exactly one other profile is running HERE — with several, which to close is the
 * person's call, and the notice already says what is going on.
 */
export function withSwap(n: LaunchNotice, code: string | undefined, runningOthers: { id: string; name: string }[]): LaunchNotice {
  if (code !== "CONCURRENCY_LIMIT_EXCEEDED" || runningOthers.length !== 1) return n;
  const o = runningOthers[0];
  return { ...n, action: { kind: "swap", stopId: o.id, stopName: o.name } };
}

/** The last line the browser printed that says something, for a notice. */
function lastLine(tail?: string): string | undefined {
  const lines = (tail ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l = lines[lines.length - 1];
  return l ? (l.length > 180 ? l.slice(0, 177) + "…" : l) : undefined;
}

/**
 * Why a browser stopped without the app asking, as a card notice — or null when there is nothing
 * to say (closed from its own window). See electron/exitreason.ts for how the facts are read.
 */
export function describeExit(ev: ExitFacts): LaunchNotice | null {
  const r = classifyExit(ev);
  const raw = ev.stderrTail?.trim() ? ev.stderrTail.trim() : undefined;
  switch (r.kind) {
    case "normal":
      return null;
    case "licence": {
      const ref = ev.leaseRefusal;
      const code = ref?.code?.toUpperCase();
      const inactive = code === "LICENSE_REVOKED" || code === "LICENSE_EXPIRED" || ref?.status === 403;
      const why =
        code === "CONCURRENCY_LIMIT_EXCEEDED"
          ? "Another browser took this licence's only slot."
          : inactive
            ? ref?.error || "The licence is no longer active."
            : ref?.error ||
              "Its licence stopped renewing: the key was revoked or expired, or the browser was over its plan's limit. On the free plan this also happens a few minutes after the app is closed.";
      return {
        tone: "warning",
        title: "Closed by the licence check",
        lines: [why],
        action: inactive ? { kind: "settings", section: "license" } : { kind: "retry" },
        raw,
      };
    }
    case "crash":
      return {
        tone: "error",
        title: "The browser crashed",
        lines: [
          `${r.name ? r.name[0].toUpperCase() + r.name.slice(1) + " — " : ""}${r.codeLabel}. The profile's data is not affected; launch it again.`,
        ],
        action: { kind: "retry" },
        raw,
      };
    case "killed":
      return {
        tone: "warning",
        title: "Closed from outside the app",
        lines: [`Something other than this app ended the browser (${r.codeLabel}) — Task Manager, a script, or the system.`],
        action: { kind: "retry" },
        raw,
      };
    case "profile-in-use":
      return {
        tone: "warning",
        title: "This profile's data is already open",
        lines: ["Another browser window is using the same data folder. Close it, then launch again."],
        action: { kind: "retry" },
        raw,
      };
    default: {
      const said = lastLine(ev.stderrTail);
      return {
        tone: "error",
        title: "The browser stopped unexpectedly",
        lines: [`It ended with ${r.codeLabel}.`, ...(said ? [`Its last message: ${said}`] : [])],
        action: { kind: "retry" },
        raw,
      };
    }
  }
}
