/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// Static export so Electron can load the renderer from file:// in the packaged app.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Relative asset paths for file:// loading in the packaged build.
  assetPrefix: isProd ? "./" : undefined,
  // No trailing slash: every page is exported NEXT TO index.html (out/cloud.html, not
  // out/cloud/index.html), so the relative "./_next/" asset paths above resolve for each of them.
  trailingSlash: false,
};

export default nextConfig;
