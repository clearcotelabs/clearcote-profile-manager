// What a proxy check and a launch mean, in words. Pure, so the editor, the launch message and the
// tests share one wording.

import type { ProxyCheck, UdpVerdict } from "./ipc";
import type { LastGeo, Profile } from "@/types/profile";

export type Tone = "ok" | "warn" | "bad";

const where = (g: { country?: string; city?: string; ip?: string }) =>
  [g.city, g.country].filter(Boolean).join(", ") || "an unknown place";

/** One line on UDP: what the result means for "Relay UDP through the proxy" and for WebRTC. */
export function udpLine(v: UdpVerdict | undefined, detail?: string): { tone: Tone; text: string } | null {
  switch (v) {
    case "works":
      return { tone: "ok", text: "UDP passes through this proxy, so “Relay UDP through the proxy” will work." };
    case "refused":
      return {
        tone: "warn",
        text: "UDP: this proxy refuses it. WebRTC stays blocked, which is safe; “Relay UDP through the proxy” does nothing here.",
      };
    case "no-reply":
      return { tone: "warn", text: "UDP: the proxy accepted it, but nothing came back. Treat it as not working; WebRTC stays blocked (safe)." };
    case "not-socks":
      return { tone: "warn", text: "UDP: an HTTP proxy cannot carry it. WebRTC stays blocked, which is safe." };
    case "error":
      return { tone: "warn", text: `UDP could not be tested${detail ? `: ${detail.replace(/\.$/, "")}` : ""}.` };
    default:
      return null;
  }
}

/** The editor's "Check" result. */
export function describeCheck(c: ProxyCheck): { tone: Tone; lines: string[] } {
  if (!c.ok || !c.geo?.ok) return { tone: "bad", lines: [`Doesn't work: ${c.error || c.geo?.error || "no answer through this proxy"}.`.replace(/\.\.$/, ".")] };
  const g = c.geo;
  const speed = c.ms != null ? ` · answered in ${(c.ms / 1000).toFixed(1)} s` : "";
  const lines = [`Works · exits in ${where(g)} (${g.ip ?? "?"})${speed}`];
  const u = udpLine(c.udp, c.udpDetail);
  if (u) lines.push(u.text);
  return { tone: "ok", lines };
}

/** The message after a launch: where the profile exits, and whether its region follows the proxy. */
export function launchReport(p: Pick<Profile, "proxy" | "geoip" | "timezone" | "acceptLanguage">, name: string, last?: LastGeo): string {
  if (!p.proxy) return `Launched “${name}” · no proxy: it uses this computer's own connection.`;
  const exit = last?.ip ? `exits in ${where(last)} (${last.ip})` : "through its proxy";
  const region =
    p.geoip !== false
      ? p.timezone && p.acceptLanguage
        ? " · time zone and language as you set them"
        : " · time zone and language follow the proxy"
      : "";
  return `Launched “${name}” · ${exit}${region}.`;
}
