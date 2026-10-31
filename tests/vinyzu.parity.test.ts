// The TypeScript port (electron/vinyzu.ts) against the Python it ports: every one of the 10,000 dataset records,
// converted and curated by both, must give the same profiles and the same index rows.
//
// Opt-in — needs the dataset and the Python generator's output:
//
//   pip install -r requirements.txt                       # in clearcote-profiles
//   python generate.py --out <dir>                        # ~8.5k profiles + index.json
//   CLEARCOTE_VINYZU_PARITY=<dir> \
//   CLEARCOTE_VINYZU_DATASET=<site-packages>/chrome_fingerprints \
//   npx vitest run tests/vinyzu.parity.test.ts

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildLibrary, parseVarsPy, type LibraryRow } from "../electron/vinyzu";
import * as fl from "../electron/fullLibrary";

const ROOT = vi.hoisted(() => {
  const req = require as (m: string) => unknown;
  const { mkdtempSync } = req("node:fs") as typeof import("node:fs");
  const { tmpdir } = req("node:os") as typeof import("node:os");
  return mkdtempSync(`${tmpdir()}/ccpm-vinyzu-parity-`);
});
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));

const OUT = process.env.CLEARCOTE_VINYZU_PARITY;
const DATASET = process.env.CLEARCOTE_VINYZU_DATASET;
const UPSTREAM = process.env.CLEARCOTE_VINYZU_UPSTREAM;

describe.skipIf(!OUT || !DATASET)("chrome-fingerprints converter — parity with the Python generator", () => {
  it("converts and curates every record exactly as generate.py does", async () => {
    const tables = parseVarsPy(readFileSync(join(DATASET!, "vars.py"), "utf8"));
    const records = JSON.parse(await fl.decodeXz(readFileSync(join(DATASET!, "fingerprints.json.xz"))));
    expect(records).toHaveLength(10000);

    const index = JSON.parse(readFileSync(join(OUT!, "index.json"), "utf8")) as { count: number; profiles: LibraryRow[] };
    const files = new Set(readdirSync(OUT!).filter((f) => f.startsWith("vinyzu-")));
    const rows: LibraryRow[] = [];
    const mismatched: string[] = [];
    const { kept, skipped } = buildLibrary(records, tables, (profile, row) => {
      rows.push(row);
      const want = JSON.parse(readFileSync(join(OUT!, `${row.id}.json`), "utf8"));
      try {
        expect(profile).toEqual(want);
      } catch {
        mismatched.push(row.id);
      }
      files.delete(`${row.id}.json`);
    });
    expect(mismatched.slice(0, 10)).toEqual([]);
    expect([...files].slice(0, 10)).toEqual([]); // nothing Python kept that we dropped
    expect(kept).toBe(index.count);
    expect(kept + skipped).toBe(10000);
    const byId = (a: LibraryRow, b: LibraryRow) => (a.id < b.id ? -1 : 1);
    expect(rows.sort(byId)).toEqual([...index.profiles].sort(byId));
  }, 300000);

  it.skipIf(!UPSTREAM)("builds the full library's cache once, reads devices back as Python made them, and removes it", async () => {
    const fetched: string[] = [];
    const fetchImpl = (async (url: string) => {
      fetched.push(url);
      return new Response(readFileSync(join(UPSTREAM!, url.split("/").pop()!)));
    }) as unknown as typeof fetch;

    const st = await fl.build(fetchImpl);
    expect(fetched).toHaveLength(2);
    const index = JSON.parse(readFileSync(join(OUT!, "index.json"), "utf8")) as { count: number };
    expect(st).toMatchObject({ on: true, count: index.count, skipped: 10000 - index.count });
    expect(st.bytes).toBeGreaterThan(40e6);

    const rows = fl.list();
    expect(rows).toHaveLength(index.count);
    for (const row of [rows[0], rows[1234], rows[rows.length - 1]]) {
      expect(row.full).toBe(true);
      expect(fl.isFullUrl(row.downloadUrl)).toBe(true);
      expect(JSON.parse(fl.readProfile(row.downloadUrl))).toEqual(JSON.parse(readFileSync(join(OUT!, row.name), "utf8")));
    }

    // Kept: building again (a newer app, say) uses the files it already has, without the network.
    await fl.build(fetchImpl);
    expect(fetched).toHaveLength(2);

    expect(fl.remove()).toEqual({ on: false });
    expect(existsSync(join(ROOT, "device-library"))).toBe(false);
  }, 300000);
});
