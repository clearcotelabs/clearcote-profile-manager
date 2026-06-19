import type { Config } from "tailwindcss";

// Clearcote brand tokens — https://www.clearcotelabs.com/brand
// Colors are driven by CSS variables (see app/globals.css) so the light/dark theme
// can swap them at runtime. Channel vars (--c-*) support Tailwind's /alpha modifiers.
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "rgb(var(--c-ink) / <alpha-value>)", // page background
        surface: "rgb(var(--c-surface) / <alpha-value>)", // cards & raised panels
        fog: "rgb(var(--c-fg) / <alpha-value>)", // foreground text
        accent: "rgb(var(--c-accent) / <alpha-value>)", // Clear Cyan (teal on light)
        sky: "rgb(var(--c-sky) / <alpha-value>)", // gradient midpoint / highlights
        iris: "rgb(var(--c-iris) / <alpha-value>)", // iridescent sheen
        // theme-aware overlays (alpha baked in; do NOT use /alpha modifiers on these)
        line: "var(--line)",
        "line-strong": "var(--line-strong)",
        elevate: "var(--elevate)",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "Consolas", "SFMono-Regular", "monospace"],
      },
      backgroundImage: {
        // signature gradient · #38e0d6 → #6ee7ff → #a78bfa (same vivid sheen in both themes)
        sheen: "linear-gradient(135deg, #38e0d6 0%, #6ee7ff 55%, #a78bfa 100%)",
      },
      keyframes: {
        blend: { "0%,100%": { filter: "hue-rotate(0deg)" }, "50%": { filter: "hue-rotate(45deg)" } },
        bob: { "0%,100%": { transform: "translateY(0) rotate(-1deg)" }, "50%": { transform: "translateY(-7px) rotate(1deg)" } },
        blink: { "0%,92%,100%": { transform: "scaleY(1)" }, "96%": { transform: "scaleY(0.1)" } },
        float: { "0%,100%": { transform: "translateY(0)" }, "50%": { transform: "translateY(-9px)" } },
        "fade-up": { from: { opacity: "0", transform: "translateY(12px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        twinkle: { "0%,100%": { opacity: "0.2", transform: "scale(0.7)" }, "50%": { opacity: "1", transform: "scale(1)" } },
      },
      animation: {
        blend: "blend 8s ease-in-out infinite",
        bob: "bob 5s ease-in-out infinite",
        blink: "blink 5s ease-in-out infinite",
        float: "float 6s ease-in-out infinite",
        "fade-up": "fade-up 0.5s cubic-bezier(0.16,1,0.3,1) both",
        twinkle: "twinkle 3s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
