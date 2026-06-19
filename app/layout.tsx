import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clearcote Profile Manager",
  description: "Create, save, organize, and launch Clearcote browser identities.",
};

// Apply the saved theme before first paint so there's no flash (dark is the default).
const themeScript = `try{if(localStorage.getItem('clearcote.theme')==='light')document.documentElement.classList.add('light');}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans antialiased bg-ink text-fog">{children}</body>
    </html>
  );
}
