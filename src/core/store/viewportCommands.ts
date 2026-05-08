/**
 * Module-level command bus for viewport actions that need access to the live
 * canvas handle (e.g. fitToWindow needs viewport DOM measurements). The
 * Canvas component registers callbacks on mount; UI surfaces (toolbar
 * options, menus, status bar, etc.) invoke them without prop-drilling.
 */

type Listener = () => void;

class ViewportCommands {
  fitToWindow: (() => void) | null = null;

  /** Latest viewport scroll offset (CSS pixels). Updated by useScrollZoom's
   *  on-scroll listener; subscribed to by UI surfaces that want to display the
   *  pan position (e.g. the Hand tool's options bar). */
  scrollLeft = 0;
  scrollTop = 0;
  private listeners = new Set<Listener>();

  setScroll(left: number, top: number): void {
    if (this.scrollLeft === left && this.scrollTop === top) return;
    this.scrollLeft = left;
    this.scrollTop = top;
    for (const fn of this.listeners) fn();
  }
  subscribeScroll(fn: Listener): void {
    this.listeners.add(fn);
  }
  unsubscribeScroll(fn: Listener): void {
    this.listeners.delete(fn);
  }
}

export const viewportCommands = new ViewportCommands();
