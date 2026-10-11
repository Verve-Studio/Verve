/**
 * New / Open / Save for automation workflows (`.automation` files), shared
 * by the Automation Editor's toolbar, the startup screen and the File
 * menu. Replacing a workflow with unsaved changes asks first through the
 * Unsaved Workflow dialog (`discardPrompt`, rendered by
 * `UnsavedWorkflowDialog`).
 */
import { automationSession } from "@/core/nodes/automationSession";
import { parseAutomation, serializeAutomation } from "@/core/nodes/automationFile";
import { notificationStore } from "@/core/store/notificationStore";
import { statusMessageStore } from "@/core/store/statusMessageStore";
import { openNodeEditor } from "./nodeEditorActions";

export type DiscardChoice = "save" | "discard" | "cancel";

// ─── Unsaved-changes prompt ──────────────────────────────────────────────────

let pending: { name: string; resolve: (choice: DiscardChoice) => void } | null = null;
const promptListeners = new Set<() => void>();

/** The open "save changes?" question, for the dialog that renders it. */
export const discardPrompt = {
  subscribe(fn: () => void): () => void {
    promptListeners.add(fn);
    return () => promptListeners.delete(fn);
  },
  /** Workflow name while the dialog is up, else null. */
  getSnapshot(): string | null {
    return pending?.name ?? null;
  },
  answer(choice: DiscardChoice): void {
    const p = pending;
    pending = null;
    promptListeners.forEach((fn) => fn());
    p?.resolve(choice);
  },
};

/** True when the current workflow may be replaced (saved or discarded). */
async function confirmReplace(): Promise<boolean> {
  const { dirty, name } = automationSession.getSnapshot();
  if (!dirty) return true;
  const choice = await new Promise<DiscardChoice>((resolve) => {
    pending?.resolve("cancel");
    pending = { name, resolve };
    promptListeners.forEach((fn) => fn());
  });
  if (choice === "save") return saveAutomation(false);
  return choice === "discard";
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/** Start an empty workflow. Returns false when the user cancelled. */
export async function newAutomation(): Promise<boolean> {
  if (!(await confirmReplace())) return false;
  automationSession.newWorkflow();
  return true;
}

/** Pick an `.automation` file and open it. Returns false when cancelled or
 *  the file couldn't be used (the error is shown). */
export async function openAutomation(): Promise<boolean> {
  if (!(await confirmReplace())) return false;
  try {
    const file = await window.api.openAutomationFile();
    if (!file) return false;
    const parsed = parseAutomation(file.text);
    if (!parsed.ok) {
      notificationStore.error(`Can't open ${file.path}: ${parsed.error}`);
      return false;
    }
    automationSession.open(parsed.graph, file.path);
    return true;
  } catch (err) {
    notificationStore.error(`Couldn't open the automation: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/** Save the workflow to its file, or pick one (`as`, or never saved).
 *  Returns false when cancelled or the write failed (the error is shown). */
export async function saveAutomation(as: boolean): Promise<boolean> {
  const { document, path } = automationSession.getSnapshot();
  const text = serializeAutomation(document.graph);
  try {
    let target = path;
    if (as || !target) {
      target = await window.api.saveAutomationFileAs(text, path ?? undefined);
      if (!target) return false;
    } else {
      await window.api.writeAutomationFile(target, text);
    }
    automationSession.markSaved(target);
    statusMessageStore.show(`Saved ${automationSession.getSnapshot().name}`);
    return true;
  } catch (err) {
    notificationStore.error(`Couldn't save the automation: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}


/** Startup screen / File menu: new workflow in the full-window editor. */
export async function startNewAutomation(): Promise<void> {
  if (await newAutomation()) openNodeEditor("automation", true);
}

/** Startup screen / File menu: open a workflow in the full-window editor. */
export async function startOpenAutomation(): Promise<void> {
  if (await openAutomation()) openNodeEditor("automation", true);
}
