// Per-OS details of the app's own window chrome: where its icon comes from and how the browser
// picker is set up. Kept out of main.ts (which starts the app when imported) so they are testable.

import path from "node:path";
import type { OpenDialogOptions } from "electron";

/** Where the app's icon comes from: the executable, or on macOS the `.app` bundle around it (the
 *  executable inside a bundle has only the generic Unix-program icon). */
export function iconSource(execPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "darwin") return execPath;
  const p = path.posix;
  const contents = p.dirname(p.dirname(execPath)); // <X>.app/Contents/MacOS/<exe> -> <X>.app/Contents
  return p.basename(contents) === "Contents" && p.basename(p.dirname(execPath)) === "MacOS" ? p.dirname(contents) : execPath;
}

/** The browser picker's title and filters for a host OS. */
export function pickBinaryDialog(platform: NodeJS.Platform): OpenDialogOptions {
  if (platform === "win32") {
    return {
      title: "Select the Clearcote chrome.exe",
      properties: ["openFile"],
      filters: [{ name: "Clearcote browser", extensions: ["exe"] }],
    };
  }
  if (platform === "darwin") {
    return {
      title: "Select the Clearcote browser (Chromium.app)",
      properties: ["openFile"],
      filters: [
        { name: "Applications", extensions: ["app"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
  }
  return { title: "Select the Clearcote chrome binary", properties: ["openFile"], filters: [{ name: "All files", extensions: ["*"] }] };
}
