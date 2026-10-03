// The viewer side of a cloud browser's live view: DOM events -> the small JSON events the worker
// accepts (cc-gateway src/live-input.mjs validates and translates them into Input.* / Page.*).
// The same mapping as the dashboard's live view (clearcote-site lib/hosted/live-input.ts), so the app
// and the website drive a cloud browser identically. PURE: tested without a DOM.

/** CDP modifier mask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/**
 * Where a point falls on the picture actually drawn inside an <img object-fit: contain>: 0..1 on both
 * axes, or null in the letterbox bars around it.
 */
export function framePoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  natural: { width: number; height: number },
): { x: number; y: number } | null {
  if (!(natural.width > 0 && natural.height > 0 && box.width > 0 && box.height > 0)) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  const x = (clientX - (box.left + (box.width - w) / 2)) / w;
  const y = (clientY - (box.top + (box.height - h) / 2)) / h;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

const BUTTON = ["left", "middle", "right"] as const;
export const mouseButton = (b: number) => BUTTON[b] ?? "left";

/** A wheel delta in pixels, whatever unit the browser reported it in (lines, pages). */
export function wheelPixels(delta: number, mode: number): number {
  return mode === 1 ? delta * 40 : mode === 2 ? delta * 800 : delta;
}

/**
 * The key event to send, or null when this window should keep it: a paste shortcut (the paste event
 * carries the text instead) and reload / devtools / tab shortcuts.
 */
export function keyEvent(
  type: "down" | "up",
  e: { key: string; code: string; keyCode: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
): Record<string, unknown> | null {
  const cmd = e.ctrlKey || e.metaKey;
  if (cmd && ["v", "V"].includes(e.key)) return null;
  if (["F5", "F12"].includes(e.key) || (cmd && ["r", "R", "w", "W", "t", "T"].includes(e.key))) return null;
  if (e.key.length > 32) return null;
  return {
    t: "key",
    e: type,
    key: e.key,
    code: e.code,
    kc: e.keyCode,
    ...(e.key.length === 1 && !cmd ? { text: e.key } : {}),
    m: modifiers(e),
  };
}

/** What the address bar sends: a navigation to what was typed (the worker accepts only http(s)). */
export function navTo(typed: string): Record<string, unknown> | null {
  const v = typed.trim();
  if (!v) return null;
  return { t: "nav", a: "go", url: v };
}

/** The live view's text messages: the hello (what was granted) and the page it shows. */
export type LiveText = { kind: "hello"; control: boolean } | { kind: "meta"; url: string; title: string; tabs: number } | { kind: "other" };

export function parseLiveText(data: string): LiveText {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { kind: "other" };
  }
  if (m.hello) return { kind: "hello", control: m.control === true };
  if (typeof m.url === "string") {
    return { kind: "meta", url: m.url, title: typeof m.title === "string" ? m.title : "", tabs: typeof m.tabs === "number" ? m.tabs : 1 };
  }
  return { kind: "other" };
}

/** How long to wait before reconnecting after the n-th consecutive drop: 1 s, 2 s, 4 s, … capped. */
export function reconnectDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, attempt));
}
