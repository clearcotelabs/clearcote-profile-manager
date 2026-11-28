// electron/profilelock.ts — is a profile's data folder open in another browser? On Windows the browser that has
// the folder holds <userDataDir>/lockfile open for writing with read-only sharing, so a write open is EBUSY.
// The Windows-only case plays that browser with a real handle of the same kind (PowerShell's FileShare.Read).

import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataFolderInUse, LOCK_FILE } from "../electron/profilelock";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-lock-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("dataFolderInUse", () => {
  it("a folder no browser ever opened is free", () => {
    expect(dataFolderInUse(path.join(ROOT, "never"), "win32")).toBe(false);
  });

  it("a lockfile nobody holds is free (and is left as it was)", () => {
    const dir = path.join(ROOT, "free");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, LOCK_FILE), "x");
    expect(dataFolderInUse(dir, "win32")).toBe(false);
    expect(fs.readFileSync(path.join(dir, LOCK_FILE), "utf8")).toBe("x");
  });

  it("macOS and Linux are not checked", () => {
    expect(dataFolderInUse(path.join(ROOT, "never"), "linux")).toBe(false);
    expect(dataFolderInUse(path.join(ROOT, "never"), "darwin")).toBe(false);
  });

  it.runIf(process.platform === "win32")("a lockfile held the way Chromium holds it is in use, and free once released", async () => {
    const dir = path.join(ROOT, "held");
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, LOCK_FILE);
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$f = [System.IO.File]::Open('${lock}', 'OpenOrCreate', 'Write', 'Read'); 'held'; [Console]::In.ReadLine() | Out-Null; $f.Close()`,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        ps.stdout.on("data", (d: Buffer) => d.toString().includes("held") && resolve());
        ps.on("exit", () => reject(new Error("powershell exited before holding the file")));
      });
      expect(dataFolderInUse(dir, "win32")).toBe(true);
    } finally {
      ps.stdin.end("\n");
      await new Promise((r) => ps.once("exit", r));
    }
    expect(dataFolderInUse(dir, "win32")).toBe(false);
  }, 20_000);
});
