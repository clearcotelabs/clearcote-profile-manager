// Turning a failed (or half-successful) launch into something a person can act on.
//
// Launch errors arrive as one string built up through several layers — "Could not obtain the
// browser: PRO download not authorized (HTTP 403): {"error":"…","code":"FREE_LATEST_ONLY"}" was a
// real one. Shown raw in a toast that disappeared after 3.5 s, nobody could read it, let alone act
// on it. This maps the known shapes to a title, a plain explanation and the ONE action that fixes
// it, and keeps the original text for "Copy details".

export type NoticeAction =
  | { kind: "edit"; field: string }
  | { kind: "settings"; section: "license" | "browser" }
  | { kind: "retry" };

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
  if (a.kind === "settings") return a.section === "license" ? "Licence settings" : "Browser settings";
  return a.field === "browserVersion" ? "Change version" : "Edit profile";
}
