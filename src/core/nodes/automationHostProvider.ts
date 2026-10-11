/**
 * Registry for the app's `AutomationHost` implementation (inversion of
 * control): the app shell registers it on mount (`useAutomationHost`), and
 * whatever runs workflows (the node editor's Run button) resolves it here,
 * so neither side imports the other.
 */
import type { AutomationHost } from "./automationHost";

let current: AutomationHost | null = null;
const logListeners = new Set<(message: string) => void>();

export const automationHostProvider = {
  provide(host: AutomationHost): () => void {
    current = host;
    return () => {
      if (current === host) current = null;
    };
  },
  get(): AutomationHost | null {
    return current;
  },
  /** Messages from Print nodes etc. (`AutomationHost.log`), shown by the
   *  workflow runner's log. */
  emitLog(message: string): void {
    logListeners.forEach((fn) => fn(message));
  },
  onLog(fn: (message: string) => void): () => void {
    logListeners.add(fn);
    return () => logListeners.delete(fn);
  },
};
