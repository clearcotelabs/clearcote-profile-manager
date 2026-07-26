// Validate + summarize a captured clearcote-profile for display.
//
// Split out of main.ts so it is reachable from tests: main.ts registers IPC handlers and creates a
// BrowserWindow at import time, so nothing inside it can be exercised directly. This is the module
// that decides whether a file is a usable capture at all, and it is where the screen guard is
// attached — both worth pinning.

import { screenGuardWarning } from "./fpargs";
import type { FingerprintMeta } from "./types";

/** Validate a parsed JSON looks like a clearcote-profile and summarize it for display. */
export function summarizeFingerprint(obj: unknown): { ok: boolean; meta?: FingerprintMeta } {
  if (!obj || typeof obj !== "object") return { ok: false };
  const o = obj as Record<string, any>;
  // A capture is identified structurally rather than by a version field: real captures in the wild
  // predate any schema marker, so requiring one would reject valid donor profiles.
  const looksLikeProfile = !!(o.webgl || o.screen || o.hardware_concurrency != null);
  if (!looksLikeProfile) return { ok: false };
  const debug = o.webgl?.webgl1?.debug || {};
  const sc = o.screen || {};
  const w = typeof sc.width === "number" ? sc.width : undefined;
  const h = typeof sc.height === "number" ? sc.height : undefined;
  return {
    ok: true,
    meta: {
      label: o.meta?.id || undefined,
      renderer: debug.UNMASKED_RENDERER_WEBGL || undefined,
      cores: typeof o.hardware_concurrency === "number" ? o.hardware_concurrency : undefined,
      memory: typeof o.device_memory === "number" ? o.device_memory : undefined,
      screen: w && h ? `${w}x${h}` : undefined,
      screenWidth: w,
      screenHeight: h,
      // A capture from a small display can't hold a real browser window — the window ends up bigger
      // than the screen it claims to sit on. Surfaced at import time rather than silently producing
      // impossible geometry at launch.
      screenWarning: screenGuardWarning(w, h) ?? undefined,
    },
  };
}
