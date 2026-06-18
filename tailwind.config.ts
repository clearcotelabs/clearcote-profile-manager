import type { Config } from "tailwindcss";

// Clearcote brand tokens — https://www.clearcotelabs.com/brand
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#07080a", // background — deep, glossy near-black
        surface: "#0d0f13", // cards & raised panels
        fog: "#e6e9ee", // foreground text on Ink
        accent: "#38e0d6", // Clear Cyan — the 'clear' in clear coat
        sky: "#6ee7ff", // gradient midpoint / highlights
        iris: "#a78bfa", // Iris — the iridescent sheen
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "Consolas", "SFMono-Regular", "monospace"],
      },
      backgroundImage: {
        // signature gradient · #38e0d6 → #6ee7ff → #a78bfa
        sheen: "linear-gradient(135deg, #38e0d6 0%, #6ee7ff 55%, #a78bfa 100%)",
      },
    },
  },
  plugins: [],
};

export default config;
