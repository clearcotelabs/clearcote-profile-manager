// Applying a settings object sent by the renderer. Pure, so the rules are pinned by tests.
//
// The renderer holds a COPY of the settings and sends the whole object back on every change. Fields
// the main process owns must not be overwritten from that copy: a launch can learn the plan while
// the renderer's copy still predates it, and the next toggle in Settings would erase it.

import type { Settings } from "./types";

export function mergeRendererSettings(
  cur: Settings,
  incoming: Settings,
): { next: Settings; licenceChanged: boolean } {
  const keyChanged = (incoming.licenseKey || "") !== (cur.licenseKey || "");
  const baseChanged = (incoming.licenseApiBase || "") !== (cur.licenseApiBase || "");
  return {
    // A different key starts with no known plan; the same key keeps what the main process learned.
    next: { ...incoming, lastPlan: keyChanged ? undefined : cur.lastPlan },
    licenceChanged: keyChanged || baseChanged,
  };
}
