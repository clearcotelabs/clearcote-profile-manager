// electron/jetslots.ts and electron/devtools.ts — the pure parts of running a task: which {{slots}} a goal has,
// what each profile fills them with, how secrets are masked, and how a DevTools port file is read.

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => require("node:os").tmpdir() } }));
import { templateSlots, normalizeTemplate, profileValues, valuesFor, maskSecrets } from "../electron/jetslots";
import { parseActivePort, debugPortArgs, hasOwnDebugPort, DEBUG_PORT_SWITCH } from "../electron/devtools";
import { exportList } from "../electron/profiles";
import type { Profile } from "../electron/types";

const P = (over: Partial<Profile> = {}) => ({ id: "shop-07", name: "Shop 07", ...over }) as Profile;

describe("templateSlots / normalizeTemplate", () => {
  it("finds each slot once, in order, with spaces around the name allowed", () => {
    expect(templateSlots("Log in as {{email}} then {{ name }} and {{email}} again")).toEqual(["email", "name"]);
    expect(templateSlots("no slots here { {x} } {{}} {{1bad}}")).toEqual([]);
    expect(templateSlots("{{a.b}} {{c-d}} {{_e}}")).toEqual(["a.b", "c-d", "_e"]);
  });

  it("writes every slot one way, so two spellings are one task", () => {
    expect(normalizeTemplate("  Log in as {{ email }} ")).toBe("Log in as {{email}}");
    expect(normalizeTemplate("Log in as {{email}}")).toBe(normalizeTemplate("Log in as {{  email}}"));
  });
});

describe("profileValues / valuesFor", () => {
  it("built-ins: name, id, group and tags", () => {
    expect(profileValues(P({ group: "UK", tags: ["warm", "shop"] })).values).toEqual({
      name: "Shop 07",
      id: "shop-07",
      group: "UK",
      tags: "warm, shop",
    });
  });

  it("task values add to them and win over a built-in of the same name; bad names are skipped", () => {
    const { values, secret } = profileValues(
      P({ vars: [{ key: "email", value: "a@x.io" }, { key: "name", value: "Ana" }, { key: "1x", value: "no" }, { key: "pw", value: "s", secret: true }] }),
    );
    expect(values).toMatchObject({ email: "a@x.io", name: "Ana", pw: "s" });
    expect(values).not.toHaveProperty("1x");
    expect(secret).toEqual(["pw"]);
  });

  it("sends only the slots the goal uses, lists empty ones as missing, and names only used secrets", () => {
    const p = P({ vars: [{ key: "email", value: "a@x.io" }, { key: "pw", value: "s", secret: true }, { key: "otp", value: "", secret: true }, { key: "x", value: "1", secret: true }] });
    expect(valuesFor("Log in as {{email}} with {{pw}} and {{otp}} {{city}}", p)).toEqual({
      values: { email: "a@x.io", pw: "s" },
      secret: ["pw"],
      missing: ["otp", "city"],
      live: {},
    });
  });
});

describe("maskSecrets", () => {
  it("replaces every occurrence, longest secret first", () => {
    const values = { a: "abc", b: "abcdef", c: "public" };
    expect(maskSecrets("x abcdef y abc z public", values, ["a", "b"])).toBe("x {{b}} y {{a}} z public");
  });
  it("an empty secret masks nothing (and does not loop)", () => {
    expect(maskSecrets("text", { a: "" }, ["a"])).toBe("text");
  });
});

describe("export leaves secret task values out", () => {
  it("keeps the name, empties the value, and keeps them with includeSecrets", () => {
    const p = P({ vars: [{ key: "email", value: "a@x.io" }, { key: "pw", value: "s3cret", secret: true }] } as Partial<Profile>);
    expect(exportList([p])[0].vars).toEqual([{ key: "email", value: "a@x.io" }, { key: "pw", value: "", secret: true }]);
    expect(exportList([p], { includeSecrets: true })[0].vars?.[1].value).toBe("s3cret");
    expect(p.vars?.[1].value).toBe("s3cret"); // the saved profile is not touched
  });
});

describe("DevTools port file", () => {
  it("reads the port from the first line only when it is a port", () => {
    expect(parseActivePort("51234\n/devtools/browser/abc\n")).toBe(51234);
    expect(parseActivePort("51234\r\n/x")).toBe(51234);
    expect(parseActivePort("")).toBeNull();
    expect(parseActivePort("5123")).toBe(5123);
    expect(parseActivePort("abc\n")).toBeNull();
    expect(parseActivePort("0\n")).toBeNull();
    expect(parseActivePort("70000\n")).toBeNull();
  });

  it("adds port 0 unless the user's own flags already open one", () => {
    expect(debugPortArgs()).toEqual([DEBUG_PORT_SWITCH]);
    expect(debugPortArgs(["--lang=en"])).toEqual([DEBUG_PORT_SWITCH]);
    expect(hasOwnDebugPort(["--remote-debugging-port=9222"])).toBe(true);
    expect(hasOwnDebugPort(["--remote-debugging-port"])).toBe(true);
    expect(hasOwnDebugPort(["--remote-debugging-pipe"])).toBe(false);
    expect(debugPortArgs(["--remote-debugging-port=9222"])).toEqual([]);
  });
});
