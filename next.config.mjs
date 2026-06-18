/** @type {import('next').NextConfig} */
const isProd = process.env.NODE_ENV === "production";

// Static export so Electron can load the renderer from file:// in the packaged app.
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  // Relative asset paths for file:// loading in the packaged build.
  assetPrefix: isProd ? "./" : undefined,
  trailingSlash: true,
};

export default nextConfig;
