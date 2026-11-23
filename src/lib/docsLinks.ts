// Where the editor's help links go: the Profile Manager guide on clearcotelabs.com, one section per
// part of the editor. The guide is written for people who do not write code; the SDK docs are not.
// Pure, so a test pins that every category has its section and that the desktop app may open it
// (electron/handlers.ts ALLOWED_EXTERNAL).

import type { CategoryId } from "./fields";

export const PM_GUIDE_URL = "https://www.clearcotelabs.com/docs/profile-manager";

/** The guide's section for each part of the editor (ids on the docs page). */
export const GUIDE_SECTIONS = {
  simple: "create",
  identity: "settings-identity",
  browser: "settings-browser",
  hardware: "settings-hardware",
  network: "settings-network",
  rendering: "settings-rendering",
  session: "settings-session",
  cloud: "settings-cloud",
} as const satisfies Record<"simple" | CategoryId, string>;

export function guideUrl(part: keyof typeof GUIDE_SECTIONS): string {
  return `${PM_GUIDE_URL}#${GUIDE_SECTIONS[part]}`;
}
