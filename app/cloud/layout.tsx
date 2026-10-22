import type { Metadata } from "next";

// The cloud viewer only means something for a running session: keep it out of search results.
export const metadata: Metadata = {
  title: "Cloud browser",
  robots: { index: false, follow: false },
  alternates: { canonical: "/cloud" },
};

export default function CloudLayout({ children }: { children: React.ReactNode }) {
  return children;
}
