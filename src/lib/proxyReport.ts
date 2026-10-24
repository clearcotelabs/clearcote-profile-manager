// What a proxy check and a launch mean, in words. Pure, so the editor, the launch message and the
// tests share one wording.

import type { ProxyCheck, UdpVerdict } from "./ipc";
import type { LastGeo, Profile } from "@/types/profile";
import { webrtcIpFollowsProxy } from "../../electron/proxyargs";

export type Tone = "ok" | "warn" | "bad";

/** "exits in Amsterdam, Netherlands (81.2.3.4)", or "exits at 81.2.3.4" when the place is not known. */
const exitsAt = (g: { country?: string; city?: string; ip?: string }) => {
  const place = [g.city, g.country].filter(Boolean).join(", ");
  return place ? `exits in ${place} (${g.ip ?? "?"})` : `exits at ${g.ip ?? "an unknown address"}`;
};

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

/** What the browser will report over WebRTC when the proxy now exits at `exit`, given the profile's
 *  stored WebRTC IP. One line, or null when they agree (or nothing is stored). Residential sticky
 *  sessions move every few minutes; an address the app resolved is refreshed at launch, one the user
 *  typed is kept — and will disagree with HTTP. */
export function webrtcIpLine(stored: Pick<Profile, "webrtcIp" | "lastGeo"> | undefined, exit: string | undefined): { tone: Tone; text: string } | null {
  const ip = stored?.webrtcIp;
  if (!ip || !exit || ip === exit) return null;
  if (webrtcIpFollowsProxy(stored)) {
    return { tone: "ok", text: `The exit has moved since “Resolve from proxy” stored ${ip} as the WebRTC IP. Each launch looks it up again, so the browser will report ${exit}.` };
  }
  return {
    tone: "warn",
    text: `WebRTC IP is set to ${ip}, which is not this exit: pages will see HTTP from ${exit} and WebRTC from ${ip}. Clear the field, or click “Resolve from proxy”, to keep them together.`,
  };
}

/** Check with Relay UDP off: why UDP was left alone. The editor offers "Test UDP" next to it. */
export const UDP_NOT_TESTED =
  "UDP not tested: with “Relay UDP through the proxy” off the browser sends none through this proxy, and a test can move a sticky session to another exit.";

/** The warning the editor shows before an explicit UDP test. */
export const UDP_TEST_WARNING =
  "Many residential proxies move a sticky session to another exit the first time UDP goes through it, and keep it there. Test anyway?";

/** The editor's "Check" result. `stored` is the profile being edited, for the WebRTC IP comparison. */
export function describeCheck(c: ProxyCheck, stored?: Pick<Profile, "webrtcIp" | "lastGeo">): { tone: Tone; lines: string[] } {
  if (!c.ok || !c.geo?.ok) return { tone: "bad", lines: [`Doesn't work: ${c.error || c.geo?.error || "no answer through this proxy"}.`.replace(/\.\.$/, ".")] };
  const g = c.geo;
  const speed = c.ms != null ? ` · answered in ${(c.ms / 1000).toFixed(1)} s` : "";
  const lines = [`Works · ${exitsAt(g)}${speed}`];
  const u = udpLine(c.udp, c.udpDetail);
  if (u) lines.push(u.text);
  if (c.udpSkipped) lines.push(UDP_NOT_TESTED);
  if (c.moved) lines.push(`The UDP test moved this session from ${c.moved.from} to ${c.moved.to}. It stays on ${c.moved.to} from now on.`);
  const w = webrtcIpLine(stored, g.ip);
  if (w) lines.push(w.text);
  return { tone: w?.tone === "warn" ? "warn" : "ok", lines };
}

/** The message after a launch: where the profile exits, whether its region follows the proxy, and
 *  a typed WebRTC IP that does not match the exit. */
export function launchReport(p: Pick<Profile, "proxy" | "geoip" | "timezone" | "acceptLanguage" | "webrtcIp" | "lastGeo">, name: string, last?: LastGeo): string {
  if (!p.proxy) return `Launched “${name}” · no proxy: it uses this computer's own connection.`;
  const exit = last?.ip ? exitsAt(last) : "through its proxy";
  const region =
    p.geoip !== false
      ? p.timezone && p.acceptLanguage
        ? " · time zone and language as you set them"
        : " · time zone and language follow the proxy"
      : "";
  const w = webrtcIpLine(p, last?.ip);
  const webrtc = w?.tone === "warn" ? ` · WebRTC reports ${p.webrtcIp}, not this exit` : "";
  return `Launched “${name}” · ${exit}${region}${webrtc}.`;
}
