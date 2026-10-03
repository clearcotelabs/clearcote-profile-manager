"use client";

// The viewer window's page: /cloud?id=<profile id> (out/cloud.html in the packaged app). The main process opens it (electron/main.ts
// openViewer) with the same preload as the main window; the id is read client-side because the app
// is a static export with no server to read it.

import { useEffect, useState } from "react";
import CloudViewer from "@/components/CloudViewer";
import { ConfirmProvider } from "@/components/Confirm";

export default function CloudPage() {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setId(new URLSearchParams(window.location.search).get("id"));
  }, []);
  if (id === undefined) return null;
  if (!id) {
    return (
      <main className="flex h-screen items-center justify-center p-6 text-sm text-fog/60">
        No profile was given. Open a cloud browser from its card in the Profile Manager.
      </main>
    );
  }
  return (
    <ConfirmProvider>
      <CloudViewer profileId={id} />
    </ConfirmProvider>
  );
}
