// What the next launch will actually run — the header pill.
//
// It used to read "Browser ready" only for a hand-picked or sibling dev binary, so every normal user
// on managed downloads saw an amber "Browser not set" forever, with a tooltip sending them to
// Settings to fix a problem they did not have. The shape below comes from the main process
// (electron/launchTarget.ts); this file only words it.

export interface LaunchTarget {
  /** custom: an explicit binary wins for every profile. managed: builds resolve from the catalog.
   *  offline: managed, but the catalog could not be reached. preview: the browser-only design mock.
   *  unavailable: a Mac with no build to launch (no licence key, or not Apple Silicon). */
  mode: "custom" | "managed" | "offline" | "preview" | "unavailable";
  /** Why, for "unavailable". */
  reason?: string;
  path?: string;
  licensed?: boolean;
  /** Last plan the licence service reported ("free", "pro"…), when known. */
  plan?: string;
  /** The build a profile on "Latest" resolves to, for this licence. */
  version?: string;
  major?: number;
  /** Already in the download cache (so the next launch is instant). */
  downloaded?: boolean;
}

export function planName(plan?: string): string {
  if (!plan) return "Licensed";
  if (plan === "free") return "Free plan";
  if (plan === "pro") return "Pro";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

export interface TargetView {
  text: string;
  tone: "ok" | "warn" | "muted";
  title: string;
  /** Which Settings section explains / changes it. */
  section: "browser" | "license";
}

export function describeTarget(t: LaunchTarget | null): TargetView {
  if (!t) {
    return { text: "Checking…", tone: "muted", title: "Working out which browser build launches.", section: "browser" };
  }
  if (t.mode === "preview") {
    return { text: "Browser preview", tone: "muted", title: "Launching works in the desktop app.", section: "browser" };
  }
  if (t.mode === "custom") {
    return {
      text: "Custom binary",
      tone: "warn",
      title: `Every profile launches ${t.path ?? "a custom binary"}, whatever version it asks for. Settings → Browser switches back to managed builds.`,
      section: "browser",
    };
  }
  if (t.mode === "unavailable") {
    return {
      text: "No browser for this Mac",
      tone: "warn",
      title: t.reason ?? "This Mac has no Clearcote build to launch.",
      // No key: the licence is what is missing. With one, it is the CPU: a binary or the cloud.
      section: t.licensed ? "browser" : "license",
    };
  }
  const who = t.licensed ? planName(t.plan) : "Open build";
  if (t.mode === "offline" || !t.major) {
    return {
      text: `${who} · offline`,
      tone: "warn",
      title: "Couldn't reach the version catalog. Launching tries again, and builds you already downloaded still work.",
      section: "browser",
    };
  }
  const tail = t.downloaded ? "." : " — it downloads on the first launch that needs it.";
  return {
    text: `${who} · ${t.major}`,
    tone: "ok",
    title: t.licensed
      ? `Profiles set to Latest launch Clearcote ${t.version}${tail}`
      : `No licence key, so profiles launch the open build, Clearcote ${t.version}${tail}`,
    section: "license",
  };
}
