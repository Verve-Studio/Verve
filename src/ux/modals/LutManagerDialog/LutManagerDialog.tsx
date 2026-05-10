// ─── LUT Manager dialog ──────────────────────────────────────────────────────
//
// Lists every LUT in `lutStore` with its source, input/output spaces, and
// affordances to remove user LUTs or set one as the active view transform.
// The actual "Load LUT…" / "Load OCIO Config…" pickers live on the menu
// (they don't need to be inside the modal), but we surface buttons here
// for convenience.

import React, { useEffect, useState } from "react";
import { ModalDialog } from "../ModalDialog/ModalDialog";
import { DialogButton } from "../../widgets/DialogButton/DialogButton";
import {
  LUT_CATEGORY_LABEL,
  lutCategory,
  lutStore,
  type LutTransform,
} from "@/core/lut";
import { displayStore } from "@/ux/main/Canvas/displayStore";
import { useLutOps } from "@/core/services/useLutOps";
import styles from "./LutManagerDialog.module.scss";

export interface LutManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

function useStoreSnapshot<T>(read: () => T): T {
  const [v, setV] = useState<T>(read);
  useEffect(() => lutStore.subscribe(() => setV(read())), [read]);
  return v;
}

function describeSource(lut: LutTransform): string {
  switch (lut.source.kind) {
    case "builtin":
      return "Built-in";
    case "cube-file":
      return `.cube · ${lut.source.path}`;
    case "ocio":
      return `OCIO · ${lut.source.colorspace}`;
  }
}

export function LutManagerDialog({
  open,
  onClose,
}: LutManagerDialogProps): React.JSX.Element | null {
  const luts = useStoreSnapshot(() => lutStore.all());
  const [activeViewLut, setActiveViewLut] = useState<string | null>(
    () => displayStore.viewTransformLutId,
  );
  useEffect(() => {
    const fn = (): void => setActiveViewLut(displayStore.viewTransformLutId);
    displayStore.subscribe(fn);
    return () => displayStore.unsubscribe(fn);
  }, []);
  const { loadCubeLut, loadOcioConfig, setViewTransform, removeLut } =
    useLutOps();

  return (
    <ModalDialog open={open} title="LUT Manager" width={640} onClose={onClose}>
      <div className={styles.body}>
        <div className={styles.toolbar}>
          <DialogButton onClick={() => void loadCubeLut()}>
            Load .cube…
          </DialogButton>
          <DialogButton onClick={() => void loadOcioConfig()}>
            Load OCIO Config…
          </DialogButton>
          <span className={styles.flex} />
          <DialogButton
            onClick={() => setViewTransform(null)}
            disabled={activeViewLut === null}
          >
            Clear View Transform
          </DialogButton>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Source</th>
                <th>In → Out</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {luts.length === 0 && (
                <tr>
                  <td colSpan={6} className={styles.empty}>
                    No LUTs loaded.
                  </td>
                </tr>
              )}
              {luts.map((l) => {
                const isActive = activeViewLut === l.id;
                return (
                  <tr key={l.id} className={isActive ? styles.active : ""}>
                    <td className={styles.name}>{l.name}</td>
                    <td className={styles.source}>
                      {LUT_CATEGORY_LABEL[lutCategory(l)]}
                    </td>
                    <td className={styles.source}>{describeSource(l)}</td>
                    <td className={styles.spaces}>
                      {l.inputSpace} → {l.outputSpace}
                    </td>
                    <td>
                      {l.cube.size}³{l.shaper ? ` + ${l.shaper.size}` : ""}
                    </td>
                    <td className={styles.actions}>
                      <button
                        className={styles.action}
                        onClick={() =>
                          setViewTransform(isActive ? null : l.id)
                        }
                      >
                        {isActive ? "Clear" : "Set as View"}
                      </button>
                      {l.source.kind !== "builtin" && (
                        <button
                          className={styles.actionDanger}
                          onClick={() => removeLut(l.id)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={styles.footer}>
        <DialogButton onClick={onClose} primary>
          Close
        </DialogButton>
      </div>
    </ModalDialog>
  );
}
