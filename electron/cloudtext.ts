// Words for cloud sessions, shared by the main process (tray, notifications) and the window.
// PURE: no node: imports.

/**
 * Why a cloud session ended, in a sentence. The reasons are the service's own: the worker's
 * (cc-gateway session.end) and the session's final status (expired: never started; lost: its server
 * went away).
 */
export function endReasonText(reason: string | null | undefined, status?: string): string {
  const r = (reason ?? "").trim();
  if (r === "idle_timeout") return "Nobody watched or typed for 30 minutes, so it closed.";
  if (r === "max_duration") return "It ran for the longest a session may run.";
  if (r === "max_bytes") return "It reached this profile's traffic cap.";
  if (r === "stopped:user" || r === "user" || r === "stopped") return "Stopped.";
  if (r === "stopped:balance" || r === "balance") return "Your cloud balance ran out. Top it up to start it again.";
  if (r.startsWith("stopped:")) return "The service stopped it.";
  if (r === "client_closed_browser" || r === "browser_closed" || r === "browser_exited") return "The browser closed.";
  if (r === "browser_error" || r === "launch_failed") return "The browser stopped with an error.";
  if (r === "run_finished") return "Its agent run finished.";
  if (r === "cancelled") return "It was stopped before it started.";
  if (status === "expired") return "It never started: nothing connected to it in time.";
  if (status === "lost") return "Its server stopped answering.";
  return r ? `It ended (${r}).` : "It ended.";
}

/** "1.4 MB", "820 KB", "2.31 GB". */
export function formatBytes(n: number | undefined): string {
  const b = Math.max(0, n ?? 0);
  if (b < 1000) return `${b} B`;
  if (b < 1e6) return `${Math.round(b / 1e3)} KB`;
  if (b < 1e9) return `${(b / 1e6).toFixed(1)} MB`;
  return `${(b / 1e9).toFixed(2)} GB`;
}

/** Euros with enough digits to show a cloud session's cost: "€0.0021", "€1.40", "< €0.0001". */
export function formatEur(n: number | undefined): string {
  const v = Math.max(0, n ?? 0);
  if (v > 0 && v < 0.0001) return "< €0.0001";
  return `€${v.toFixed(v > 0 && v < 0.01 ? 4 : 2)}`;
}

/** "42 s", "3 min", "1 h 05 min". */
export function formatDuration(seconds: number | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}
