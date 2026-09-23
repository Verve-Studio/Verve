import { useCallback, useState } from "react";
import { activeScope } from "@/core/store/scope";

interface TransformGuardParams {
  /** Resolves true when committed; false leaves the transform open. */
  handleTransformApply: () => Promise<boolean>;
  handleTransformCancel: () => void;
}

export function useTransformGuard({
  handleTransformApply,
  handleTransformCancel,
}: TransformGuardParams) {
  const [pendingGuardedAction, setPendingGuardedAction] = useState<
    (() => void) | null
  >(null);

  const requireTransformDecision = useCallback((action: () => void): void => {
    if (activeScope().transform.isActive) {
      setPendingGuardedAction(() => action);
      return;
    }
    action();
  }, []);

  const handleTransformGuardApply = useCallback((): void => {
    const pending = pendingGuardedAction;
    setPendingGuardedAction(null);
    if (!pending) return;
    // Commit, then run the guarded action (tool switch, tab switch, …). If
    // the commit fails the transform stays open and the action is dropped;
    // the error is already shown to the user.
    void handleTransformApply().then((ok) => {
      if (ok) pending();
    });
  }, [pendingGuardedAction, handleTransformApply]);

  const handleTransformGuardDiscard = useCallback((): void => {
    const pending = pendingGuardedAction;
    setPendingGuardedAction(null);
    if (!pending) return;
    handleTransformCancel();
    pending();
  }, [pendingGuardedAction, handleTransformCancel]);

  return {
    pendingGuardedAction,
    setPendingGuardedAction,
    requireTransformDecision,
    handleTransformGuardApply,
    handleTransformGuardDiscard,
  };
}
