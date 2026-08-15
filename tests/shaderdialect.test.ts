import { describe, it, expect } from "vitest";
import {
  withShaderDialect,
  shaderDialectWarning,
  isShaderDialect,
  SHADER_DIALECT_ENV,
} from "../electron/shaderdialect";

describe("withShaderDialect", () => {
  it("leaves the env untouched when no dialect is requested", () => {
    // Specifically must return `undefined` — NOT a copy of process.env. The launcher passes
    // undefined to mean "inherit the parent environment"; replacing it with a snapshot would
    // silently change what the child sees.
    expect(withShaderDialect(undefined, undefined)).toBeUndefined();
    const base = { FOO: "1" };
    expect(withShaderDialect(undefined, base)).toBe(base);
    expect(withShaderDialect("", base)).toBe(base);
  });

  it("sets the variable the GPU process reads", () => {
    const out = withShaderDialect("hlsl", { FOO: "1" })!;
    expect(out[SHADER_DIALECT_ENV]).toBe("hlsl");
    expect(out.FOO).toBe("1"); // existing entries preserved
  });

  it("normalises case and surrounding whitespace", () => {
    expect(withShaderDialect("  HLSL  ", {})![SHADER_DIALECT_ENV]).toBe("hlsl");
  });

  it("does not mutate the base env", () => {
    const base: NodeJS.ProcessEnv = { FOO: "1" };
    withShaderDialect("hlsl", base);
    expect(base[SHADER_DIALECT_ENV]).toBeUndefined();
  });

  it("throws on an unknown dialect rather than ignoring it", () => {
    // A typo must fail loudly: silently dropping it would leave the engine reporting the honest
    // SPIR-V while the profile claims a Direct3D11 renderer — the exact contradiction this exists
    // to remove, now invisible to the user.
    expect(() => withShaderDialect("glsl", {})).toThrow(/must be one of hlsl/i);
    expect(() => withShaderDialect("spirv", {})).toThrow();
  });
});

describe("isShaderDialect", () => {
  it("accepts hlsl in any casing", () => {
    expect(isShaderDialect("hlsl")).toBe(true);
    expect(isShaderDialect("HLSL")).toBe(true);
  });
  it("rejects anything else", () => {
    expect(isShaderDialect("glsl")).toBe(false);
    expect(isShaderDialect(undefined)).toBe(false);
    expect(isShaderDialect(1)).toBe(false);
  });
});

describe("shaderDialectWarning", () => {
  it("silent when the dialect is not requested", () => {
    expect(shaderDialectWarning(undefined, 149, "linux")).toBeNull();
    expect(shaderDialectWarning(undefined, 151, "win32")).toBeNull();
  });

  it("warns that a pre-151 build ignores the variable", () => {
    const msg = shaderDialectWarning("hlsl", 150, "linux");
    expect(msg).toContain("151");
    expect(msg).toContain("150");
  });

  it("warns that it is a no-op on a Windows host", () => {
    // D3D11 already answers in HLSL there, so switching it on achieves nothing and the user should
    // know rather than assume they have changed something.
    expect(shaderDialectWarning("hlsl", 151, "win32")).toMatch(/no effect on a Windows host/i);
  });

  it("silent on a Linux host with a 151 build — the case it is for", () => {
    expect(shaderDialectWarning("hlsl", 151, "linux")).toBeNull();
  });

  it("the version warning takes precedence over the platform one", () => {
    expect(shaderDialectWarning("hlsl", 149, "win32")).toContain("151");
  });

  it("stays quiet for an explicit binary of unknown version", () => {
    expect(shaderDialectWarning("hlsl", undefined, "linux")).toBeNull();
  });
});
