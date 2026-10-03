// electron/cloudtext.ts: why a cloud session ended, and its usage, in words. The reasons are the
// service's own (cc-gateway session.end, the control plane's final statuses).

import { describe, it, expect } from "vitest";
import { endReasonText, formatBytes, formatDuration, formatEur } from "../electron/cloudtext";

describe("endReasonText", () => {
  it("words every reason the service reports", () => {
    const cases: [string, string][] = [
      ["idle_timeout", "Nobody watched or typed for 30 minutes, so it closed."],
      ["max_duration", "It ran for the longest a session may run."],
      ["max_bytes", "It reached this profile's traffic cap."],
      ["stopped:user", "Stopped."],
      ["stopped:balance", "Your cloud balance ran out. Top it up to start it again."],
      ["stopped:control_plane", "The service stopped it."],
      ["client_closed_browser", "The browser closed."],
      ["browser_closed", "The browser closed."],
      ["browser_exited", "The browser closed."],
      ["browser_error", "The browser stopped with an error."],
      ["launch_failed", "The browser stopped with an error."],
      ["run_finished", "Its agent run finished."],
      ["cancelled", "It was stopped before it started."],
    ];
    for (const [reason, text] of cases) expect(endReasonText(reason), reason).toBe(text);
  });

  it("falls back to the final status, then to the raw reason", () => {
    expect(endReasonText(null, "expired")).toBe("It never started: nothing connected to it in time.");
    expect(endReasonText(undefined, "lost")).toBe("Its server stopped answering.");
    expect(endReasonText("something_new")).toBe("It ended (something_new).");
    expect(endReasonText("", "ended")).toBe("It ended.");
    expect(endReasonText("  idle_timeout  ")).toBe("Nobody watched or typed for 30 minutes, so it closed.");
  });
});

describe("usage", () => {
  it("bytes, in the unit a person reads", () => {
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(20_360)).toBe("20 KB");
    expect(formatBytes(1_400_000)).toBe("1.4 MB");
    expect(formatBytes(2_310_000_000)).toBe("2.31 GB");
  });

  it("euros, with the digits a session's small cost needs", () => {
    expect(formatEur(undefined)).toBe("€0.00");
    expect(formatEur(0)).toBe("€0.00");
    expect(formatEur(0.000021)).toBe("< €0.0001"); // a 21-second session: not "€0.0000"
    expect(formatEur(0.0001)).toBe("€0.0001");
    expect(formatEur(0.0021)).toBe("€0.0021");
    expect(formatEur(0.01)).toBe("€0.01");
    expect(formatEur(1.4)).toBe("€1.40");
    expect(formatEur(-1)).toBe("€0.00");
  });

  it("durations", () => {
    expect(formatDuration(undefined)).toBe("0 s");
    expect(formatDuration(42.4)).toBe("42 s");
    expect(formatDuration(59.6)).toBe("1 min");
    expect(formatDuration(185)).toBe("3 min");
    expect(formatDuration(3900)).toBe("1 h 05 min");
  });
});
