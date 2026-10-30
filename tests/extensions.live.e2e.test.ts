// Live end-to-end: an extension added from the real Chrome Web Store runs in a profile the app's real
// launch() opens, under its store ID.
//
// Opt-in — it needs the network, a Clearcote binary (and, for a PRO one, the licence key in
// CLEARCOTE_LICENSE_KEY or ~/.clearcote/license.key):
//
//   CLEARCOTE_E2E=1 CLEARCOTE_BINARY="/path/to/chrome.exe" npx vitest run tests/extensions.live.e2e.test.ts

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Profile } from "../electron/types";

const READY = process.env.CLEARCOTE_E2E === "1" && !!process.env.CLEARCOTE_BINARY;
const ROOT = READY ? fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-ext-e2e-")) : path.join(os.tmpdir(), "ccpm-ext-e2e-unused");
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

/** uBlock Origin Lite: a public Manifest V3 extension with a service worker. */
const STORE_ID = process.env.CLEARCOTE_E2E_EXTENSION || "ddkjiahejlhfcafbddmgiahcphecmpfh";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function targets(port: number, ms: number, ok: (t: { type: string; url: string }[]) => boolean) {
  const deadline = Date.now() + ms;
  let last: { type: string; url: string }[] = [];
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (r.ok) {
        last = (await r.json()) as { type: string; url: string }[];
        if (ok(last)) return last;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

describe.skipIf(!READY)("a Web Store extension runs in a launched profile", () => {
  const id = "ext-e2e";
  let launcher: typeof import("../electron/launcher");

  beforeAll(() => {
    if (!process.env.CLEARCOTE_LICENSE_KEY) {
      const f = path.join(os.homedir(), ".clearcote", "license.key");
      if (fs.existsSync(f)) process.env.CLEARCOTE_LICENSE_KEY = fs.readFileSync(f, "utf8").trim();
    }
  });
  afterAll(async () => {
    await launcher?.stop(id).catch(() => {});
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it("downloads and verifies it, and the browser runs it under the store ID", async () => {
    const store = await import("../electron/store");
    store.writeSettings({ ...store.readSettings(), binaryPath: process.env.CLEARCOTE_BINARY });
    const ext = await import("../electron/extensions");
    const profiles = await import("../electron/profiles");
    launcher = await import("../electron/launcher");

    const e = await ext.addFromStore(store.ROOT, `https://chromewebstore.google.com/detail/x/${STORE_ID}`);
    expect(e.id).toBe(STORE_ID);
    expect(e.source).toBe("store");
    console.log(`added ${e.name} ${e.version}`);

    const port = await freePort();
    profiles.saveProfile({
      id,
      name: "extension e2e",
      fingerprint: "ext-e2e-seed",
      platform: "windows",
      extensions: [STORE_ID],
      extraArgs: [`--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check"],
      createdAt: "",
      updatedAt: "",
    } as Profile);
    const res = await launcher.launch(profiles.getProfile(id)!);
    expect(res.ok, res.error).toBe(true);
    expect(res.warnings?.join(" ") ?? "").not.toMatch(/extension/i);

    const prefix = `chrome-extension://${STORE_ID}/`;
    const list = await targets(port, 60000, (l) => l.some((t) => t.url.startsWith(prefix)));
    console.log(list.map((t) => `${t.type} ${t.url}`).join("\n"));
    expect(list.some((t) => t.type === "service_worker" && t.url.startsWith(prefix))).toBe(true);

    // The extension's own pages load from the kept copy (its manifest, key included, is what Chrome read).
    const page = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(prefix + "manifest.json")}`, { method: "PUT" });
    expect(page.ok).toBe(true);
  }, 240000);
});
