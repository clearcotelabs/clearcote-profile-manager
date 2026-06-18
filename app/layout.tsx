import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearcote Profile Manager",
  description: "Create, save, organize, and launch Clearcote browser identities.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased bg-ink text-fog">{children}</body>
    </html>
  );
}
