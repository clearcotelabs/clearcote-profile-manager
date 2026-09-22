// What closing the window does while browsers are running. PURE, so the rule is tested.
//
// Quitting the app used to be silent about running browsers. On the free plan that is worse than it
// sounds: the app is what keeps each browser's licence token renewed, so a browser left behind by a
// closed app stops ITSELF a few minutes later (the engine's licence watchdog), with nothing on screen saying why.
// Keeping the app in the tray keeps the renewals going.

export type CloseBehavior = "ask" | "tray" | "quit";
export type CloseAction = "close" | "ask" | "tray" | "stop-and-quit";

export function closeAction(runningCount: number, behavior: CloseBehavior | undefined, quitting: boolean): CloseAction {
  if (quitting || runningCount <= 0) return "close";
  if (behavior === "tray") return "tray";
  if (behavior === "quit") return "stop-and-quit";
  return "ask";
}

/** The question, worded for how many browsers are open. Button order matches ASK_BUTTONS. */
export function askText(n: number): { message: string; detail: string } {
  return {
    message: n === 1 ? "1 browser is still running." : `${n} browsers are still running.`,
    detail:
      "In the tray, the app keeps their licences renewed and they keep running. If the app closes, " +
      "a browser on the free plan stops by itself within a few minutes.",
  };
}

export const ASK_BUTTONS = ["Keep running in the tray", "Close browsers and quit", "Cancel"] as const;
