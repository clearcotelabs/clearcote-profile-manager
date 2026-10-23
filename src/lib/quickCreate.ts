// The shortcuts that make a new profile quick: this display's screen in one click, a proxy picked up
// from the clipboard, and the switches a proxy adds, said in words. Pure, so the editor and the tests
// share one definition.

import { parseProxy } from "../../electron/proxyargs";
import { proxyEgressArgs } from "../../electron/fpargs";
import type { Profile } from "@/types/profile";

export interface HostScreen {
  width: number;
  height: number;
  availWidth?: number;
  availHeight?: number;
}

/** The four screen fields set to this display. The work area falls back to the full size only when
 *  the browser reports none (it always does in Chrome and Electron). */
export function withHostScreen(p: Profile, host: HostScreen): Profile {
  return {
    ...p,
    screenWidth: host.width,
    screenHeight: host.height,
    availWidth: host.availWidth ?? host.width,
    availHeight: host.availHeight ?? host.height,
  };
}

/** All four screen fields empty: the seed or a capture supplies a screen that agrees with itself. */
export function withoutScreen(p: Profile): Profile {
  const { screenWidth: _w, screenHeight: _h, availWidth: _aw, availHeight: _ah, ...rest } = p;
  return rest as Profile;
}

/** "host" when all four typed values are this display's, "empty" when none is typed, else "other". */
export function screenSource(p: Profile, host: HostScreen | undefined): "host" | "empty" | "other" {
  const typed = [p.screenWidth, p.screenHeight, p.availWidth, p.availHeight];
  if (typed.every((v) => v == null)) return "empty";
  if (!host) return "other";
  const want = withHostScreen({} as Profile, host);
  return p.screenWidth === want.screenWidth &&
    p.screenHeight === want.screenHeight &&
    p.availWidth === want.availWidth &&
    p.availHeight === want.availHeight
    ? "host"
    : "other";
}

/** A proxy address in clipboard text, in the form the profile stores, or null. Stricter than
 *  parseProxy (which reads any word as a host on port 80): one line, an explicit port, and a host
 *  that is an IP or has a dot — so a copied sentence or password is never offered as a proxy. */
export function proxyFromText(text: string | null | undefined): string | null {
  const v = (text ?? "").trim();
  if (!v || v.length > 500 || /[\r\n]/.test(v)) return null;
  const p = parseProxy(v);
  if (!p || !p.portGiven) return null;
  const host = p.host.replace(/^\[|\]$/g, "");
  if (!host.includes(".") && !host.includes(":") && host !== "localhost") return null;
  return p.raw;
}

/** The address a proxy is shown as in an offer: host and port, never the credentials. */
export function proxyLabel(proxy: string): string {
  const p = parseProxy(proxy);
  return p ? `${p.host}:${p.port}` : proxy;
}

export interface ProtectedSwitch {
  arg: string;
  title: string;
  why: string;
}

const PROTECTED_TEXT: Record<string, Omit<ProtectedSwitch, "arg">> = {
  "--disable-quic": {
    title: "No HTTP/3 (QUIC)",
    why: "A proxy carries ordinary connections only. HTTP/3 would go around it, straight from your real IP. Real Chrome behind a proxy never uses it either.",
  },
  "--webrtc-ip-handling-policy=disable_non_proxied_udp": {
    title: "WebRTC only through the proxy",
    why: "Video, voice and WebRTC checks can't reach a site from your real IP. \"Relay UDP through the proxy\" still works on top of this when the proxy allows UDP.",
  },
};

/** The switches added because a proxy is set, each with a sentence on why — the ones people find
 *  in the launch command and ask about. Empty without a proxy. */
export function protectedSwitches(p: Profile): ProtectedSwitch[] {
  return proxyEgressArgs(!!parseProxy(p.proxy), p.extraArgs).map((arg) => ({
    arg,
    ...(PROTECTED_TEXT[arg] ?? { title: arg, why: "Added because a proxy is set." }),
  }));
}
