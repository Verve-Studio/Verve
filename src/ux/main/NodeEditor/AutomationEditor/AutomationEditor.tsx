import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { automationSession } from "@/core/nodes/automationSession";
import { NodeCanvas } from "../NodeCanvas/NodeCanvas";
import { workflowRunStore } from "../workflowRunStore";
import { newAutomation, openAutomation, saveAutomation } from "../automationFiles";
import styles from "./AutomationEditor.module.scss";

/** The Automation tab: file commands, a Run / Stop bar, the workflow graph
 *  and the run log. */
export function AutomationEditor(): React.JSX.Element {
  const session = useSyncExternalStore(automationSession.subscribe, automationSession.getSnapshot);
  const doc = session.document;
  const run = useSyncExternalStore(workflowRunStore.subscribe, workflowRunStore.getSnapshot);
  const [logOpen, setLogOpen] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);
  const last = run.log[run.log.length - 1];

  // Follow the log as it grows.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.log, logOpen]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.fileGroup}>
          <button type="button" className={styles.button} title="New automation" onClick={() => void newAutomation()}>
            New
          </button>
          <button type="button" className={styles.button} title="Open an .automation file" onClick={() => void openAutomation()}>
            Open…
          </button>
          <button
            type="button"
            className={styles.button}
            title={session.path ? `Save to ${session.path}` : "Save as an .automation file"}
            onClick={() => void saveAutomation(false)}
          >
            Save
          </button>
          <button type="button" className={styles.button} title="Save to a new .automation file" onClick={() => void saveAutomation(true)}>
            Save As…
          </button>
          <span className={styles.fileName} title={session.path ?? "Not saved yet"}>
            {session.name}
            {session.dirty && <span className={styles.dirty} aria-label="Unsaved changes"> •</span>}
          </span>
        </div>
        <span className={styles.divider} />
        {run.running ? (
          <button type="button" className={`${styles.button} ${styles.stop}`} onClick={() => workflowRunStore.stop()}>
            ■ Stop
          </button>
        ) : (
          <button
            type="button"
            className={`${styles.button} ${styles.run}`}
            title="Run the workflow from its On Run node"
            onClick={() => void workflowRunStore.run(doc.graph)}
          >
            ▶ Run
          </button>
        )}
        <span
          className={[
            styles.status,
            run.running ? styles.statusBusy : last?.kind === "error" ? styles.statusError : last?.kind === "ok" ? styles.statusOk : "",
          ].join(" ")}
          title={last?.text}
        >
          {run.running ? "Running…" : (last?.text ?? "Ready")}
        </span>
        <button
          type="button"
          className={`${styles.button}${logOpen ? ` ${styles.toggleOn}` : ""}`}
          aria-pressed={logOpen}
          onClick={() => setLogOpen(!logOpen)}
        >
          Log{run.log.length > 0 ? ` (${run.log.length})` : ""}
        </button>
      </div>
      <div className={styles.main}>
        <NodeCanvas key={doc.graph.id} doc={doc} errorNodeId={run.errorNodeId} />
        {logOpen && (
          <aside className={styles.logPanel}>
            <div className={styles.logHeader}>
              <span>Run Log</span>
              <button
                type="button"
                className={styles.clear}
                disabled={run.log.length === 0 || run.running}
                onClick={() => workflowRunStore.clearLog()}
              >
                Clear
              </button>
            </div>
            <div ref={logRef} className={styles.log}>
              {run.log.length === 0 ? (
                <p className={styles.empty}>Print nodes and run results appear here.</p>
              ) : (
                run.log.map((line) => (
                  <div key={line.id} className={`${styles.line} ${styles[line.kind]}`}>
                    {line.text}
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
