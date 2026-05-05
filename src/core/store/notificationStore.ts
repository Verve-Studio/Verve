/**
 * Global, app-wide notification surface for non-fatal errors that need to be
 * shown to the user (e.g. `MemoryLimitError` thrown by `memoryStore.alloc`,
 * GPU device-lost warnings, etc).
 *
 * Any code path can call `notificationStore.error(message)` and the active
 * notification will appear in the main UI for `AUTO_DISMISS_MS`. The store
 * is deliberately tiny: one message at a time, latest wins. Subscribers
 * read `current()`.
 *
 * This is the right place for "thing failed; user should know" messages.
 * It is NOT for in-progress / status text (those have their own per-feature
 * stores), nor for dialog-quality errors that need acknowledgement.
 */
import { useSyncExternalStore } from "react";

const AUTO_DISMISS_MS = 6000;

class NotificationStore {
  private message: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  current(): string | null {
    return this.message;
  }

  /** Show an error message. Replaces any currently-displayed message. */
  error(message: string): void {
    this.message = `⚠ ${message}`;
    this.notify();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.message = null;
      this.timer = null;
      this.notify();
    }, AUTO_DISMISS_MS);
  }

  dismiss(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.message = null;
    this.notify();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const notificationStore = new NotificationStore();

/** React hook: subscribe to the active notification. */
export function useNotification(): string | null {
  return useSyncExternalStore(
    (cb) => notificationStore.subscribe(cb),
    () => notificationStore.current(),
  );
}
