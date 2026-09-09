/**
 * Lets a render's poll loop skip the rest of its wait and check again right
 * now, when the tab comes back to the foreground.
 *
 * Without this, a customer who locks their phone mid-render doesn't get
 * stuck forever (the browser eventually fires the queued timer once it
 * resumes JS execution), but they can sit looking at a stale "4%" for
 * however long the OS chose to throttle background timers by — which reads
 * exactly like a hung render. Waking every in-flight poll the moment the
 * page is visible again turns that dead air into an immediate check.
 */

type Waiter = () => void;

const waiters = new Set<Waiter>();

function wakeAll(): void {
  for (const wake of waiters) wake();
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wakeAll();
  });
  window.addEventListener("focus", wakeAll);
  window.addEventListener("online", wakeAll);
}

/** Same shape as `new Promise((r) => setTimeout(r, ms))`, but wakeable. */
export function sleepOrWake(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const waiter: Waiter = () => {
      clearTimeout(timer);
      waiters.delete(waiter);
      resolve();
    };
    const timer = setTimeout(waiter, ms);
    waiters.add(waiter);
  });
}
