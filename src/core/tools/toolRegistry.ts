import type { Tool } from "@/types";
import type { ITool, ToolPlacement } from "./_shared/ITool";

const tools = new Map<Tool, ITool>();

/**
 * One row in the toolbar = up to two tools (left + right cell). `null` is a
 * blank cell, used when a row is half-full (e.g. eraser sits alone in the
 * second row of the painting group).
 */
export type ToolbarRow = (ITool | null)[];

/** A toolbar group = ordered list of rows, separated visually from other groups. */
export type ToolbarGroup = ToolbarRow[];

export const toolRegistry = {
  register(tool: ITool): void {
    if (tools.has(tool.id)) {
      console.warn(`[toolRegistry] duplicate registration: ${tool.id}`);
    }
    tools.set(tool.id, tool);
  },

  get(id: Tool): ITool | undefined {
    return tools.get(id);
  },

  /** Throwing variant for callsites where a missing tool is a programmer error. */
  require(id: Tool): ITool {
    const t = tools.get(id);
    if (!t) throw new Error(`[toolRegistry] no tool registered: ${id}`);
    return t;
  },

  has(id: Tool): boolean {
    return tools.has(id);
  },

  all(): readonly ITool[] {
    return Array.from(tools.values());
  },

  /**
   * Returns toolbar layout: groups in ascending `placement.group` order,
   * each group as rows in `row` order, each row of length 2 keyed by
   * `column`. Rows without a column-1 entry get a trailing `null` so the
   * grid stays uniform.
   */
  /**
   * Resolve the next tool when a shortcut key is pressed. Tools that share
   * a key (e.g. lasso ↔ polygonal-selection on `L`) form a cycle by
   * declaring `shortcutCycle` pointers. If the active tool is in the
   * cycle, advance to its declared next tool; otherwise jump into the
   * cycle at its first member. Returns null when no cycle exists for this
   * key (caller should leave the shortcut alone).
   */
  resolveShortcutCycle(key: string, active: Tool): Tool | null {
    const upper = key.toUpperCase();
    const cycle = Array.from(tools.values()).filter(
      (t) => t.shortcut === upper && t.shortcutCycle !== undefined,
    );
    if (cycle.length === 0) return null;
    const activeInCycle = cycle.find((t) => t.id === active);
    if (activeInCycle?.shortcutCycle) return activeInCycle.shortcutCycle;
    return cycle[0].id;
  },

  toolbarGroups(): ToolbarGroup[] {
    const placed = Array.from(tools.values()).filter(
      (t): t is ITool & { placement: ToolPlacement } => t.placement !== null,
    );
    // Bucket: group → row → column
    const buckets = new Map<number, Map<number, [ITool | null, ITool | null]>>();
    for (const t of placed) {
      const { group, row, column } = t.placement;
      let groupMap = buckets.get(group);
      if (!groupMap) {
        groupMap = new Map();
        buckets.set(group, groupMap);
      }
      let rowArr = groupMap.get(row);
      if (!rowArr) {
        rowArr = [null, null];
        groupMap.set(row, rowArr);
      }
      if (rowArr[column] !== null) {
        console.warn(
          `[toolRegistry] placement collision at group=${group} row=${row} col=${column}: ${rowArr[column]?.id} vs ${t.id}`,
        );
      }
      rowArr[column] = t;
    }
    const groupKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
    return groupKeys.map((g) => {
      const rowMap = buckets.get(g)!;
      const rowKeys = Array.from(rowMap.keys()).sort((a, b) => a - b);
      return rowKeys.map((r) => rowMap.get(r)!);
    });
  },
};
