// helper/auth.ts — who may talk to the helper: origin and Host checks, tokens bound to the site that
// paired them (only hashes on disk), and the pairing handshake. Real files in a temp dir.

import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeOrigin,
  hostOk,
  isLocalOrigin,
  allowedOrigins,
  TokenStore,
  Pairings,
  pairingCode,
  normalizeCode,
  PAIRING_TTL_MS,
  COMMAND_CODE_TTL_MS,
} from "../helper/auth";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-helper-auth-"));
afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("normalizeOrigin", () => {
  it("lower-cases the host and drops a bare trailing slash", () => {
    expect(normalizeOrigin("https://App.Clearcotelabs.com/")).toBe("https://app.clearcotelabs.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });
  it("refuses anything that is not a bare http(s) origin", () => {
    for (const bad of ["", "   ", "ftp://x.com", "file:///c:/x", "https://x.com/path", "https://x.com/?q=1", "https://x.com/#h", "https://u:p@x.com", "not a url", "javascript:alert(1)"]) {
      expect(normalizeOrigin(bad)).toBeNull();
    }
  });
});

describe("allowedOrigins", () => {
  it("has the defaults and adds valid extras only", () => {
    const s = allowedOrigins(["http://localhost:3000/", "https://evil.com/path"]);
    expect(s.has("https://app.clearcotelabs.com")).toBe(true);
    expect(s.has("http://localhost:3000")).toBe(true);
    expect(s.has("https://evil.com")).toBe(false);
  });
});

describe("hostOk", () => {
  it("accepts the helper's own names on its port", () => {
    expect(hostOk("127.0.0.1:47821", 47821)).toBe(true);
    expect(hostOk("LOCALHOST:47821", 47821)).toBe(true);
    expect(hostOk("[::1]:47821", 47821)).toBe(true);
  });
  it("refuses DNS-rebinding names, other ports and a missing Host", () => {
    expect(hostOk("evil.com:47821", 47821)).toBe(false);
    expect(hostOk("127.0.0.1.nip.io:47821", 47821)).toBe(false);
    expect(hostOk("localhost.evil.com:47821", 47821)).toBe(false);
    expect(hostOk("127.0.0.1:47822", 47821)).toBe(false);
    expect(hostOk("127.0.0.1", 47821)).toBe(false);
    expect(hostOk(undefined, 47821)).toBe(false);
  });
});

describe("isLocalOrigin", () => {
  it("is only the helper's own page", () => {
    expect(isLocalOrigin("http://127.0.0.1:47821", 47821)).toBe(true);
    expect(isLocalOrigin("http://localhost:47821", 47821)).toBe(true);
    expect(isLocalOrigin("https://127.0.0.1:47821", 47821)).toBe(false);
    expect(isLocalOrigin("http://127.0.0.1:47822", 47821)).toBe(false);
    expect(isLocalOrigin("https://app.clearcotelabs.com", 47821)).toBe(false);
    expect(isLocalOrigin(undefined, 47821)).toBe(false);
  });
});

describe("TokenStore", () => {
  const A = "https://app.clearcotelabs.com";
  const B = "https://www.clearcotelabs.com";

  it("issues a token that works for its own site only", () => {
    const file = path.join(TMP, "t1", "sites.json");
    const t = new TokenStore(file);
    const tok = t.issue(A, "Chrome on Windows");
    expect(tok).toMatch(/^cch_[A-Za-z0-9_-]{43}$/);
    expect(t.check(tok, A)?.name).toBe("Chrome on Windows");
    expect(t.check(tok, B)).toBeNull();
    expect(t.check("cch_nope", A)).toBeNull();
    expect(t.check(undefined, A)).toBeNull();
    expect(t.check(tok.slice(4), A)).toBeNull(); // without the prefix
  });

  it("keeps only hashes on disk, and survives a reload", () => {
    const file = path.join(TMP, "t2", "sites.json");
    const t = new TokenStore(file);
    const tok = t.issue(A, "x");
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain(tok);
    expect(raw).not.toContain(tok.slice(4));
    const site = JSON.parse(raw).sites[0];
    expect(site.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new TokenStore(file).check(tok, A)).not.toBeNull();
  });

  it("revokes, on disk too", () => {
    const file = path.join(TMP, "t3", "sites.json");
    const t = new TokenStore(file);
    const tok = t.issue(A, "x");
    const keep = t.issue(B, "y");
    const hash = t.list().find((s) => s.origin === A)!.hash;
    expect(t.revoke(hash)).toBe(true);
    expect(t.revoke(hash)).toBe(false);
    expect(t.check(tok, A)).toBeNull();
    expect(t.check(keep, B)).not.toBeNull();
    expect(new TokenStore(file).check(tok, A)).toBeNull();
  });

  it("caps the stored name", () => {
    const t = new TokenStore(path.join(TMP, "t4", "sites.json"));
    t.issue(A, "n".repeat(500));
    expect(t.list()[0].name.length).toBe(80);
  });
});

describe("pairingCode", () => {
  it("is XXX-XXX from an alphabet without look-alikes", () => {
    for (let i = 0; i < 200; i++) expect(pairingCode()).toMatch(/^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/);
  });
});

describe("Pairings", () => {
  const A = "https://app.clearcotelabs.com";
  const B = "https://www.clearcotelabs.com";

  it("keeps one open request per site", () => {
    const p = new Pairings();
    const a1 = p.start(A, "one");
    const b1 = p.start(B, "other");
    const a2 = p.start(A, "two");
    expect(p.get(a1.id)?.status).toBe("expired");
    expect(p.get(a2.id)?.status).toBe("pending");
    expect(p.get(b1.id)?.status).toBe("pending");
    expect(p.pending().map((x) => x.id).sort()).toEqual([a2.id, b1.id].sort());
  });

  it("expires after the TTL", () => {
    let now = 1_000_000;
    const p = new Pairings(() => now);
    const r = p.start(A, "x");
    now += PAIRING_TTL_MS - 1;
    expect(p.get(r.id)?.status).toBe("pending");
    now += 2;
    expect(p.get(r.id)?.status).toBe("expired");
    expect(p.decide(r.id, true, () => "tok")).toBeUndefined();
    expect(p.collect(r.id, r.secret)).toEqual({ status: "expired" });
    now += PAIRING_TTL_MS * 3;
    expect(p.get(r.id)).toBeUndefined();
    expect(p.collect(r.id, r.secret)).toEqual({ status: "expired" });
  });

  it("approve: the token goes once, and only to the holder of the secret", () => {
    const p = new Pairings();
    const r = p.start(A, "x");
    expect(p.collect(r.id, r.secret)).toEqual({ status: "pending" });
    expect(p.collect(r.id, "wrong")).toBeNull();
    expect(p.collect(r.id, "")).toBeNull();
    let issued = 0;
    const d = p.decide(r.id, true, () => (issued++, "cch_token"));
    expect(d?.status).toBe("approved");
    expect(issued).toBe(1);
    expect(p.decide(r.id, true, () => "again")).toBeUndefined(); // already answered
    expect(p.collect(r.id, "wrong")).toBeNull();
    expect(p.collect(r.id, r.secret)).toEqual({ status: "approved", token: "cch_token" });
    expect(p.collect(r.id, r.secret)).toEqual({ status: "expired" }); // handed over, gone
  });

  it("deny: no token", () => {
    const p = new Pairings();
    const r = p.start(A, "x");
    let issued = 0;
    expect(p.decide(r.id, false, () => (issued++, "t"))?.status).toBe("denied");
    expect(issued).toBe(0);
    expect(p.collect(r.id, r.secret)).toEqual({ status: "denied" });
  });
});

describe("the code from the command line (clearcote connect CODE)", () => {
  const A = "https://app.clearcotelabs.com";
  const B = "https://www.clearcotelabs.com";
  const issue = () => "cch_test";

  it("normalizes the way people type it", () => {
    expect(normalizeCode("4f7-k2q")).toBe("4F7K2Q");
    expect(normalizeCode(" 4F7 K2Q ")).toBe("4F7K2Q");
    for (const bad of ["", "4F7-K2", "4F7-K2QQ", "4F0-K2Q", "4F7-K1Q", "4F7_K2Q", "ABC-DEI"]) expect(normalizeCode(bad)).toBeNull();
  });

  it("refuses a code the page could never show", () => {
    expect(new Pairings().allowCode("hello")).toBe(false);
  });

  it("pairs the page that sends it at once, once", () => {
    const p = new Pairings();
    expect(p.allowCode("4f7-k2q")).toBe(true);
    const r = p.start(A, "Chrome on Windows", "4F7K2Q", issue);
    expect(r.status).toBe("approved");
    expect(r.code).toBe("4F7-K2Q");
    expect(p.pending()).toEqual([]);
    expect(p.collect(r.id, r.secret)).toEqual({ status: "approved", token: "cch_test" });
    // Used up: the next request with it waits for the approval page like any other.
    expect(p.start(B, "x", "4F7-K2Q", issue).status).toBe("pending");
  });

  it("without the code, or without a code given, nothing changes", () => {
    const p = new Pairings();
    expect(p.start(A, "x", "4F7-K2Q", issue).status).toBe("pending");
    p.allowCode("4F7-K2Q");
    expect(p.start(A, "x", undefined, issue).status).toBe("pending");
    expect(p.start(A, "x", "4F7-K2Q").status).toBe("pending"); // no issue(): the old call
    expect(p.start(A, "x", "4F7-K2Q", issue).status).toBe("approved");
  });

  it("is thrown away after 5 wrong codes", () => {
    const p = new Pairings();
    p.allowCode("4F7-K2Q");
    for (let i = 0; i < 5; i++) expect(p.start(A, "x", "222-222", issue).status).toBe("pending");
    expect(p.start(A, "x", "4F7-K2Q", issue).status).toBe("pending");
  });

  it("expires after 10 minutes", () => {
    let now = 5_000_000;
    const p = new Pairings(() => now);
    p.allowCode("4F7-K2Q");
    now += COMMAND_CODE_TTL_MS + 1;
    expect(p.start(A, "x", "4F7-K2Q", issue).status).toBe("pending");
  });
});
