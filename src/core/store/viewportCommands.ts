/**
 * Module-level command bus for viewport actions that need access to the live
 * canvas handle (e.g. fitToWindow needs viewport DOM measurements). The
 * Canvas component registers callbacks on mount; UI surfaces (toolbar
 * options, menus, status bar, etc.) invoke them without prop-drilling.
 */
class ViewportCommands {
  fitToWindow: (() => void) | null = null;
}

export const viewportCommands = new ViewportCommands();
