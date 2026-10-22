import os from "node:os";
import path from "node:path";

/** The desktop app's product name — Electron names its data folder after it. */
const PRODUCT = "Clearcote Profile Manager";

/** The folder Electron's app.getPath("userData") gives the desktop app, or CLEARCOTE_PM_DATA_DIR. */
export function dataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.CLEARCOTE_PM_DATA_DIR) return env.CLEARCOTE_PM_DATA_DIR;
  const home = os.homedir();
  if (platform === "win32") return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), PRODUCT);
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support", PRODUCT);
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, ".config"), PRODUCT);
}
