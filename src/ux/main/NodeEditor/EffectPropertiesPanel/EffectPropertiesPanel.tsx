import React from "react";
import type { GraphArgument, GraphInfo } from "@/core/nodes/graphTypes";
import { ArgumentListField } from "../ArgumentListField/ArgumentListField";
import type { ShaderIssue } from "@/core/effects/CustomShader/shaderCheck";
import styles from "./EffectPropertiesPanel.module.scss";

interface EffectPropertiesPanelProps {
  info: GraphInfo;
  onInfoChange: (patch: Partial<GraphInfo>) => void;
  /** Effect arguments: sockets on Layer Input, fields in the effect's
   *  settings window. */
  args: readonly GraphArgument[];
  onArgumentsChange: (args: readonly GraphArgument[]) => void;
  /** Result of the last check; null while checking. */
  issues: readonly ShaderIssue[] | null;
  onIssueClick: (issue: ShaderIssue) => void;
  /** The linked `.effect` file (Save overwrites it), if any. */
  source: string | null;
  /** Overwrite the linked file (or Save As when there is none). */
  onSave: () => void;
  onSaveAs: () => void;
  saving: boolean;
  /** Feedback from the last save ("Saved to …" or an error). */
  saveMessage: { ok: boolean; text: string } | null;
  onOpenFolder: () => void;
}

/** Text field that commits on blur / Enter, so typing doesn't re-render
 *  the layer on every keystroke. */
function Field({
  label,
  value,
  multiline,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  placeholder?: string;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  const common = {
    defaultValue: value,
    placeholder,
    spellCheck: false,
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const v = e.currentTarget.value;
      if (v !== value) onCommit(v);
    },
  };
  return (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {multiline ? (
        // Keyed by value: re-mount when it changes from outside (undo).
        <textarea key={value} className={styles.input} rows={4} {...common} />
      ) : (
        <input
          key={value}
          className={styles.input}
          {...common}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

/** Side panel of the shader editor: effect metadata, the compile check
 *  and saving as an `.effect` file. */
export function EffectPropertiesPanel({
  info,
  onInfoChange,
  args,
  onArgumentsChange,
  issues,
  onIssueClick,
  source,
  onSave,
  onSaveAs,
  saving,
  saveMessage,
  onOpenFolder,
}: EffectPropertiesPanelProps): React.JSX.Element {
  const errors = issues?.filter((i) => i.severity === "error") ?? [];
  const warnings = issues?.filter((i) => i.severity === "warning") ?? [];
  const canSave = issues !== null && errors.length === 0 && info.name.trim() !== "" && !saving;

  return (
    <aside className={styles.panel} aria-label="Effect properties">
      <section className={styles.section}>
        <h3 className={styles.heading}>Effect</h3>
        <Field label="Name" value={info.name} onCommit={(name) => onInfoChange({ name })} />
        <Field label="Author" value={info.author} onCommit={(author) => onInfoChange({ author })} />
        <Field
          label="Version"
          value={info.version}
          placeholder="1.0"
          onCommit={(version) => onInfoChange({ version })}
        />
        <Field
          label="Description"
          value={info.description}
          multiline
          placeholder="What does this effect do?"
          onCommit={(description) => onInfoChange({ description })}
        />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Arguments</h3>
        <p className={styles.hint}>
          Inputs of the effect: outputs on <strong>Layer Input</strong>, fields in the effect&apos;s settings
          window.
        </p>
        <ArgumentListField args={args} onChange={onArgumentsChange} />
      </section>

      <section className={styles.section}>
        <h3 className={styles.heading}>Check</h3>
        <div
          className={`${styles.status} ${
            issues === null ? "" : errors.length > 0 ? styles.statusError : styles.statusOk
          }`}
          role="status"
        >
          {issues === null
            ? "Checking…"
            : errors.length > 0
              ? `✗ ${errors.length} error${errors.length > 1 ? "s" : ""} — fix before saving`
              : warnings.length > 0
                ? `✓ Compiles (${warnings.length} warning${warnings.length > 1 ? "s" : ""})`
                : "✓ Compiles — no problems"}
        </div>
        {[...errors, ...warnings].length > 0 && (
          <ul className={styles.issues}>
            {[...errors, ...warnings].map((issue, i) => (
              <li key={i}>
                <button
                  type="button"
                  className={`${styles.issue} ${issue.severity === "error" ? styles.issueError : styles.issueWarning}`}
                  disabled={!issue.nodeId}
                  title={issue.nodeId ? "Show the node" : undefined}
                  onClick={() => onIssueClick(issue)}
                >
                  {issue.severity === "error" ? "✗" : "!"} {issue.message}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        {source && (
          <p className={styles.hint} title={source}>
            File: {source.split(/[\\/]/).pop()}
          </p>
        )}
        <div className={styles.saveRow}>
          {source && (
            <button type="button" className={styles.save} disabled={!canSave} onClick={onSave}>
              {saving ? "Saving…" : "Save"}
            </button>
          )}
          <button
            type="button"
            className={source ? styles.saveSecondary : styles.save}
            disabled={!canSave}
            onClick={onSaveAs}
          >
            {saving && !source ? "Saving…" : source ? "Save As…" : "Save as .effect…"}
          </button>
        </div>
        {saveMessage && (
          <p className={saveMessage.ok ? styles.saved : styles.saveError}>{saveMessage.text}</p>
        )}
        <p className={styles.hint}>
          Effects saved in the effects folder appear under <strong>Effects → Custom Effects</strong>.
        </p>
        <button type="button" className={styles.link} onClick={onOpenFolder}>
          Open effects folder
        </button>
      </section>
    </aside>
  );
}
