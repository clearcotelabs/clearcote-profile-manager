import type { Metadata, Viewport } from "next";
import "./globals.css";
import HelperGate from "@/components/HelperGate";
import { I18nBoot } from "@/lib/i18n";

/** The web version's address. Link previews and the canonical URL point here. */
const SITE = "https://app.clearcotelabs.com";
const TITLE = "Clearcote Profile Manager: launch browser profiles from your browser";
const DESCRIPTION =
  "Launch Clearcote browser profiles from the web. Each keeps its own fingerprint, proxy and logins, stored on your computer. Open-source helper.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s · Clearcote Profile Manager" },
  description: DESCRIPTION,
  applicationName: "Clearcote Profile Manager",
  keywords: ["browser profiles", "antidetect browser", "fingerprint", "multi-account", "profile manager", "Clearcote"],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Clearcote",
    title: TITLE,
    description: DESCRIPTION,
    locale: "en_US",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "The Clearcote Profile Manager in a browser, with profile cards and Launch buttons" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", alt: "The Clearcote Profile Manager in a browser" }],
  },
};

export const viewport: Viewport = { themeColor: "#07080a", colorScheme: "dark light" };

// What the page is, for search engines (schema.org SoftwareApplication).
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Clearcote Profile Manager",
  url: SITE,
  applicationCategory: "BrowserApplication",
  operatingSystem: "Windows, macOS, Linux",
  description: DESCRIPTION,
  image: `${SITE}/og.png`,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  publisher: { "@type": "Organization", name: "Clearcote", url: "https://www.clearcotelabs.com" },
  license: "https://opensource.org/licenses/BSD-3-Clause",
});

// Apply the saved theme before first paint so there's no flash (dark is the default).
const themeScript = `try{if(localStorage.getItem('clearcote.theme')==='light')document.documentElement.classList.add('light');}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the no-flash themeScript below sets html.class before React
    // hydrates, so the server (no class) vs client (class) attribute mismatch is intentional.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      </head>
      <body className="font-sans antialiased bg-ink text-fog">
        <I18nBoot />
        <HelperGate>{children}</HelperGate>
      </body>
    </html>
  );
}
