import { useEffect, useRef } from "react";
import type { TabRecord } from "@/core/store/tabTypes";
import { activeScope } from "@/core/store/scope";

/**
 * Keep the main process informed about which open documents have unsaved
 * changes, so it can ask before the window closes (X button, File > Exit,
 * Cmd+Q) instead of silently discarding them. Pushed on every change rather
 * than queried at close time, so the answer is available synchronously in
 * the window's `close` handler — even if the renderer is busy.
 */
export function useUnsavedDocumentsReporter(tabs: readonly TabRecord[]): void {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => {
    const report = (): void => {
      const titles = tabsRef.current
        .filter((t) => t.scope.history.isDirty())
        .map((t) => t.title);
      const key = JSON.stringify(titles);
      if (key === lastSentRef.current) return;
      lastSentRef.current = key;
      window.api.setUnsavedDocuments(titles);
    };
    report();
    // History subscribers are module-level, so this fires for whichever
    // tab's history changes while it is active.
    return activeScope().history.subscribe(report);
  }, [tabs]);
}
