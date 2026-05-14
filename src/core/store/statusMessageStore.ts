/**
 * Transient status confirmations rendered in the bottom StatusBar
 * (e.g. "File saved", "Image exported", "Sent to printer"). One message at a
 * time, latest wins, auto-dismisses after `AUTO_DISMISS_MS`.
 *
 * This is for *success / informational* status text. Use `notificationStore`
 * for errors that need a warning surface.
 */
import { useSyncExternalStore } from "react";

const AUTO_DISMISS_MS = 4000;

class StatusMessageStore {
  private message: string | null = null;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  current(): string | null {
    return this.message;
  }

  show(message: string): void {
    this.message = message;
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

export const statusMessageStore = new StatusMessageStore();

export function useStatusMessage(): string | null {
  return useSyncExternalStore(
    (cb) => statusMessageStore.subscribe(cb),
    () => statusMessageStore.current(),
  );
}
