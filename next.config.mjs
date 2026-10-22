import { execFileSync } from "node:child_process";

/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// The newest released helper (its helper-v* tag), baked into the web version so its download button
// links straight to the files without asking GitHub's API first (which a browser may be refused).
function helperVersion() {
  if (process.env.NEXT_PUBLIC_HELPER_VERSION) return process.env.NEXT_PUBLIC_HELPER_VERSION;
  try {
    const tag = execFileSync("git", ["tag", "--list", "helper-v*", "--sort=-v:refname"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    return tag.replace(/^helper-v/, "");
  } catch {
    return "";
  }
}

// Static export so Electron can load the renderer from file:// in the packaged app.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Relative asset paths for file:// loading in the packaged build.
  assetPrefix: isProd ? "./" : undefined,
  // No trailing slash: every page is exported NEXT TO index.html (out/cloud.html, not
  // out/cloud/index.html), so the relative "./_next/" asset paths above resolve for each of them.
  trailingSlash: false,
  env: { NEXT_PUBLIC_HELPER_VERSION: helperVersion() },
};

export default nextConfig;
