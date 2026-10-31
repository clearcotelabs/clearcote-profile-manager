// electron/totp.ts and the 2FA secret around it: RFC 6238's own test vectors through Web Crypto, secrets as sites show
// them and otpauth:// links, the code to type near the end of a window, {{otp}} for tasks (the secret goes to Jet, never
// a code), a task's run line, export without secrets, and the 2FA key column in other tools' exports.

import { describe, it, expect, vi, afterAll } from "vitest";
import { rmSync } from "node:fs";

const { ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  return { ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "ccpm-totp-")) as string };
});
vi.mock("electron", () => ({ app: { getPath: () => ROOT } }));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

import { groupCode, parseTotp, totpAt, totpNow, totpToType, type TotpSpec } from "../electron/totp";
import { valuesFor } from "../electron/jetslots";
import { exportList } from "../electron/profiles";
import { parseMigration } from "../electron/migrate";
import type { Profile } from "../electron/types";

const b32 = (ascii: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of Buffer.from(ascii)) bits += ch.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
};
const KEY1 = b32("12345678901234567890");
const KEY256 = b32("12345678901234567890123456789012");
const KEY512 = b32("1234567890123456789012345678901234567890123456789012345678901234");
const spec = (secret: string, algorithm: TotpSpec["algorithm"], digits = 8): TotpSpec => ({ secret, algorithm, digits, period: 30 });

describe("TOTP codes", () => {
  it.each([
    [KEY1, "SHA1", 59, "94287082"],
    [KEY256, "SHA256", 59, "46119246"],
    [KEY512, "SHA512", 59, "90693936"],
    [KEY1, "SHA1", 1111111109, "07081804"],
    [KEY256, "SHA256", 1234567890, "91819424"],
    [KEY512, "SHA512", 2000000000, "38618901"],
    [KEY1, "SHA1", 20000000000, "65353130"],
  ] as const)("RFC 6238: %s %s at %i s is %s", async (key, alg, t, want) => {
    expect(await totpAt(spec(key, alg), Math.floor(t / 30))).toBe(want);
  });

  it("reads a secret however a site shows it, and otpauth links with their settings", () => {
    const spaced = KEY1.toLowerCase().replace(/(.{4})/g, "$1 ");
    expect(parseTotp(spaced)).toEqual({ ok: true, spec: { secret: KEY1, digits: 6, period: 30, algorithm: "SHA1" } });
    const link = `otpauth://totp/Shop:ana%40example.com?secret=${KEY1}&issuer=Shop%20Inc&algorithm=SHA256&digits=8&period=60`;
    expect(parseTotp(link)).toEqual({
      ok: true,
      spec: { secret: KEY1, digits: 8, period: 60, algorithm: "SHA256", issuer: "Shop Inc", account: "ana@example.com" },
    });
  });

  it.each([
    ["", /No 2FA secret/],
    ["hello world!", /base32/],
    ["JBSWY3DP", /too short/],
    [`otpauth://hotp/x?secret=${KEY1}`, /time-based/],
    [`otpauth://totp/x?secret=${KEY1}&digits=4`, /6 to 8 digits/],
    [`otpauth://totp/x?secret=${KEY1}&algorithm=MD5`, /Unknown 2FA algorithm/],
  ])("refuses %j", (input, why) => {
    const r = parseTotp(input);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(why);
  });

  it("the code to type is this window's, or the next one in the last 3 seconds", async () => {
    const s = spec(KEY1, "SHA1", 6);
    expect(await totpToType(KEY1, (1000 * 30 + 10) * 1000)).toBe(await totpAt(s, 1000));
    expect(await totpToType(KEY1, (1000 * 30 + 27) * 1000)).toBe(await totpAt(s, 1001));
    expect(await totpToType("nope", 0)).toBeNull();
    expect(await totpNow(s, (1000 * 30 + 12) * 1000)).toEqual({ code: await totpAt(s, 1000), secondsLeft: 18 });
    expect(groupCode("123456")).toBe("123 456");
    expect(groupCode("12345678")).toBe("1234 5678");
  });
});

describe("{{otp}} in tasks", () => {
  const p = (over: Partial<Profile> = {}) => ({ id: "a", name: "Ana", ...over }) as Profile;

  it("sends the profile's 2FA secret to Jet as a live value, never a code, and not as a plain value", () => {
    expect(valuesFor("Sign in with {{otp}} as {{name}}", p({ totp: ` ${KEY1} ` }))).toEqual({
      values: { name: "Ana" },
      secret: [],
      missing: [],
      live: { otp: KEY1 },
    });
  });

  it("a profile without a secret is missing {{otp}}; a task value named otp wins over the secret", () => {
    expect(valuesFor("code {{otp}}", p()).missing).toEqual(["otp"]);
    const own = valuesFor("code {{otp}}", p({ totp: KEY1, vars: [{ key: "otp", value: "000000" }] }));
    expect(own).toMatchObject({ values: { otp: "000000" }, live: {} });
  });
});

describe("the 2FA secret elsewhere", () => {
  it("is left out of an export unless secrets are included", () => {
    const list = [{ id: "a", name: "A", fingerprint: "1", createdAt: "", updatedAt: "", totp: KEY1 } as Profile];
    expect(exportList(list)[0].totp).toBeUndefined();
    expect(exportList(list, { includeSecrets: true })[0].totp).toBe(KEY1);
  });

  it("comes across from other tools' exports (AdsPower's fakey and the usual names), and a bad one is said", () => {
    const csv = `name,fakey,proxy\nShop,${KEY1},\nBank,not a key!,\n`;
    const r = parseMigration(csv, "adspower.csv");
    expect(r.profiles.map((x) => [x.name, x.totp])).toEqual([["Shop", KEY1], ["Bank", undefined]]);
    expect(r.warnings.join(" ")).toMatch(/Bank.*2FA key could not be read/);
    const json = JSON.stringify([{ name: "Mail", "2FA Secret": KEY1 }, { name: "Shop", totp: `otpauth://totp/x?secret=${KEY1}` }]);
    expect(parseMigration(json, "x.json").profiles.map((x) => x.totp)).toEqual([KEY1, `otpauth://totp/x?secret=${KEY1}`]);
  });
});
