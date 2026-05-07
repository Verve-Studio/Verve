import { useCallback, useState } from "react";
import { transformStore } from "@/core/store/transformStore";

interface TransformGuardParams {
  handleTransformApply: () => void;
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
    if (transformStore.isActive) {
      setPendingGuardedAction(() => action);
      return;
    }
    action();
  }, []);

  const handleTransformGuardApply = useCallback((): void => {
    const pending = pendingGuardedAction;
    setPendingGuardedAction(null);
    if (!pending) return;
    // Subscribe to the store so we run the pending action after the async WASM apply finishes.
    const onComplete = (): void => {
      if (!transformStore.isActive) {
        transformStore.unsubscribe(onComplete);
        pending();
      }
    };
    transformStore.subscribe(onComplete);
    handleTransformApply();
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
