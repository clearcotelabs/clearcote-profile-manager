// Stands in for the "electron" module when the helper is bundled (build.mjs aliases it here).
// The shared code needs exactly one thing from Electron, the app's data folder, and gets the same
// folder the desktop app uses, so both see the same profiles.

import { dataDir } from "./paths";

export const app = {
  getPath(name: string): string {
    if (name !== "userData") throw new Error(`The helper has no Electron path "${name}".`);
    return dataDir();
  },
};
