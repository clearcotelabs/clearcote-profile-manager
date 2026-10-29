// What the next launch will actually run — the header pill.
//
// It used to read "Browser ready" only for a hand-picked or sibling dev binary, so every normal user
// on managed downloads saw an amber "Browser not set" forever, with a tooltip sending them to
// Settings to fix a problem they did not have. The shape below comes from the main process
// (electron/launchTarget.ts); this file only words it.

import { t } from "./i18n";

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
  if (!plan) return t("Licensed");
  if (plan === "free") return t("Free plan");
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

export function describeTarget(lt: LaunchTarget | null): TargetView {
  if (!lt) {
    return { text: t("Checking…"), tone: "muted", title: t("Working out which browser build launches."), section: "browser" };
  }
  if (lt.mode === "preview") {
    // The web version says what to do: connect this computer (HelperGate), not "use the desktop app".
    const web = process.env.NEXT_PUBLIC_PM_TARGET === "web";
    return {
      text: web ? t("Preview") : t("Browser preview"),
      tone: "muted",
      title: web ? t("Connect this computer to launch browsers.") : t("Launching works in the desktop app."),
      section: "browser",
    };
  }
  if (lt.mode === "custom") {
    return {
      text: t("Custom binary"),
      tone: "warn",
      title: lt.path
        ? t("Every profile launches {path}, whatever version it asks for. Settings → Browser switches back to managed builds.", { path: lt.path })
        : t("Every profile launches a custom binary, whatever version it asks for. Settings → Browser switches back to managed builds."),
      section: "browser",
    };
  }
  if (lt.mode === "unavailable") {
    return {
      text: t("No browser for this Mac"),
      tone: "warn",
      title: lt.reason ?? t("This Mac has no Clearcote build to launch."),
      // No key: the licence is what is missing. With one, it is the CPU: a binary or the cloud.
      section: lt.licensed ? "browser" : "license",
    };
  }
  const who = lt.licensed ? planName(lt.plan) : t("Open build");
  if (lt.mode === "offline" || !lt.major) {
    return {
      text: t("{who} · offline", { who }),
      tone: "warn",
      title: t("Couldn't reach the version catalog. Launching tries again, and builds you already downloaded still work."),
      section: "browser",
    };
  }
  const version = lt.version ?? "undefined";
  return {
    text: `${who} · ${lt.major}`,
    tone: "ok",
    title: lt.licensed
      ? lt.downloaded
        ? t("Profiles set to Latest launch Clearcote {version}.", { version })
        : t("Profiles set to Latest launch Clearcote {version} — it downloads on the first launch that needs it.", { version })
      : lt.downloaded
        ? t("No licence key, so profiles launch the open build, Clearcote {version}.", { version })
        : t("No licence key, so profiles launch the open build, Clearcote {version} — it downloads on the first launch that needs it.", { version }),
    section: "license",
  };
}
