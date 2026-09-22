// Remembering where the window was. PURE, so the "is it still on a screen?" rule is tested.
//
// A saved position is only reused when enough of the window's title bar lands on a display that
// exists NOW — otherwise a window last used on a monitor that has since been unplugged would open
// off-screen, which on Windows means invisible and unreachable.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindow extends Rect {
  maximized?: boolean;
}

export interface Restored {
  /** Undefined: open at the default size, centred. */
  bounds?: Rect;
  maximized: boolean;
}

/** How much of the title bar must be on-screen to count as reachable. */
const GRAB_W = 120;
const GRAB_H = 32;

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { w: Math.max(0, w), h: Math.max(0, h) };
}

export function restoreBounds(
  saved: SavedWindow | undefined,
  workAreas: Rect[],
  limits: { minWidth: number; minHeight: number },
): Restored {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return { maximized: false };
  const maximized = !!saved.maximized;
  // The title bar strip: where the user grabs the window to move it.
  const titleBar: Rect = { x: saved.x, y: saved.y, width: saved.width, height: GRAB_H };
  const host = workAreas.find((a) => {
    const o = overlap(titleBar, a);
    return o.w >= Math.min(GRAB_W, saved.width) && o.h >= GRAB_H / 2;
  });
  if (!host) return { maximized };
  // Never larger than the screen it is on, never smaller than the app's minimum.
  const width = Math.max(limits.minWidth, Math.min(saved.width, host.width));
  const height = Math.max(limits.minHeight, Math.min(saved.height, host.height));
  const x = Math.min(Math.max(saved.x, host.x), host.x + host.width - width);
  const y = Math.min(Math.max(saved.y, host.y), host.y + host.height - height);
  return { bounds: { x, y, width, height }, maximized };
}
