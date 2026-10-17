// The OS this app runs on, as the renderer sees it. The renderer has a real navigator, so this needs
// no IPC: Electron's user agent names the OS ("Windows NT", "Macintosh", "X11; Linux").

import type { Platform } from "@/types/profile";

export type HostOs = "windows" | "macos" | "linux";

/** The OS from a navigator's platform + user agent, or undefined when neither names one. */
export function hostOsFrom(platform: string, userAgent: string): HostOs | undefined {
  const p = `${platform} ${userAgent}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac")) return "macos";
  if (p.includes("linux") || p.includes("x11")) return "linux";
  return undefined;
}

/** This renderer's OS, or undefined outside a browser (the static export's prerender). */
export function hostOs(): HostOs | undefined {
  if (typeof navigator === "undefined") return undefined;
  return hostOsFrom(navigator.platform, navigator.userAgent);
}

/** The browser as a person looks for it on this OS: the file to pick, or the macOS app bundle. */
export function browserFileName(host: HostOs | undefined): string {
  if (host === "macos") return "Chromium.app";
  if (host === "linux") return "chrome";
  return "chrome.exe";
}

/** The program name at the start of the editor's command-line preview. */
export function browserCommandName(host: HostOs | undefined): string {
  if (host === "macos") return "Chromium";
  if (host === "linux") return "chrome";
  return "chrome.exe";
}

/**
 * The persona platform a new profile starts with. Windows, as it always was — except on a Mac: the
 * macOS browser's fonts and canvas text metrics are the Mac's own whatever the persona claims, so a
 * Windows persona there would contradict itself on every font check. On a Mac a new profile is a Mac.
 */
export function defaultPersonaPlatform(host: HostOs | undefined): Platform {
  return host === "macos" ? "macos" : "windows";
}

/** How a shortcut's modifier reads on this OS ("⌘S" on a Mac, "Ctrl+S" elsewhere). The app's
 *  handlers take Ctrl or Cmd on every OS; this is only what the label says. */
export function shortcutLabel(key: string, host: HostOs | undefined): string {
  return host === "macos" ? `⌘${key}` : `Ctrl+${key}`;
}

/** A key chip of the shortcuts list ("Ctrl N") as this OS spells it ("⌘ N" on a Mac). */
export function keysLabel(label: string, host: HostOs | undefined): string {
  return host === "macos" ? label.replace(/^Ctrl /, "⌘ ") : label;
}
