// Optional HLSL shader dialect for a Windows persona on a non-Windows host (engine 151 r15+).
//
// A page can ask WEBGL_debug_shaders.getTranslatedShaderSource() for the shader source ANGLE's
// active backend produced. A Windows persona advertises a Direct3D11 renderer, but on a Linux host
// the Vulkan backend answers with a SPIR-V dump — so the renderer string and the dialect beside it
// describe two different technologies, with no reference data needed to notice.
//
// `shaderDialect: "hlsl"` re-translates the shader to HLSL for that query alone. Rendering is
// untouched. It is OFF by default because the re-translation is a different code path from the one
// that drew: a shader the Vulkan backend accepts but the HLSL translator rejects falls back to the
// honest SPIR-V for that shader. Turn it on when a target actually reads the dialect.
//
// Irrelevant on a Windows host (the D3D11 backend already answers in HLSL) — and this app ships
// Windows-first, so it matters for the Linux build and for anyone running a Windows persona there.
//
// Carried as an ENV VAR, not a switch, because the code lives in the GPU process, which never
// receives the fingerprint switches. Mirrors the SDK's sdk/node/src/shaderdialect.ts.

export const SHADER_DIALECT_ENV = "CLEARCOTE_SHADER_DIALECT";

/** The dialects the engine understands. Anything else is a typo, not a feature. */
export type ShaderDialect = "hlsl";

const VALID: readonly string[] = ["hlsl"];

/** Engine major that implements the variable; older builds ignore it silently. */
export const SHADER_DIALECT_MIN_MAJOR = 151;

export function isShaderDialect(v: unknown): v is ShaderDialect {
  return typeof v === "string" && VALID.includes(v.trim().toLowerCase());
}

/**
 * Fold CLEARCOTE_SHADER_DIALECT into a launch env.
 *
 * Returns `baseEnv` untouched when no dialect is requested — including `undefined`, so the caller's
 * "inherit the parent environment" default is preserved rather than being replaced by a copy of
 * process.env.
 *
 * Throws on an unknown dialect rather than ignoring it: a typo would otherwise look like it worked
 * while the engine kept reporting the honest dialect.
 */
export function withShaderDialect(
  dialect: string | undefined,
  baseEnv: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!dialect) return baseEnv;
  const value = String(dialect).trim().toLowerCase();
  if (!VALID.includes(value)) {
    throw new Error(`shaderDialect must be one of ${VALID.join(", ")} (got ${JSON.stringify(dialect)})`);
  }
  return { ...(baseEnv ?? process.env), [SHADER_DIALECT_ENV]: value };
}

/** A warning when the dialect is requested but cannot take effect, or null when it is fine.
 *  `major` is the resolved browser major (undefined for an explicit binary — unknowable, so quiet).
 *  `hostPlatform` is the OS actually running the binary. */
export function shaderDialectWarning(
  dialect: string | undefined,
  major: number | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): string | null {
  if (!dialect) return null;
  if (major !== undefined && major < SHADER_DIALECT_MIN_MAJOR) {
    return (
      `Shader dialect needs Clearcote ${SHADER_DIALECT_MIN_MAJOR} (r15+); the running build is ` +
      `${major}, which ignores it. Set the profile's browser version to ${SHADER_DIALECT_MIN_MAJOR} (PRO).`
    );
  }
  if (hostPlatform === "win32") {
    return (
      "Shader dialect has no effect on a Windows host — ANGLE's D3D11 backend already reports HLSL. " +
      "It is for running a Windows persona on Linux."
    );
  }
  return null;
}
