/**
 * The AI upscale / restore models the app offers (Image → Rescale Image /
 * Restore Image), loaded once from the main process. Lets surfaces that
 * need the list synchronously (automation node dropdowns) show the same
 * models as the dialogs.
 */
export interface UpscaleModel {
  readonly id: string;
  readonly label: string;
}

/** Restore Image's preferred model (the dialog's default). */
export const DEFAULT_RESTORE_MODEL = "realesr-general-x4v3";

let models: readonly UpscaleModel[] = [];
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

export const upscaleModelStore = {
  /** Load the list (once; later calls reuse the first load). */
  load(): Promise<void> {
    loading ??= window.api.upscale
      .listModels()
      .then((list) => {
        models = list.map((m) => ({ id: m.id, label: m.label }));
        listeners.forEach((fn) => fn());
      })
      .catch((err: unknown) => {
        loading = null;
        console.error("[upscaleModelStore] Couldn't list models:", err);
      });
    return loading;
  },
  all(): readonly UpscaleModel[] {
    return models;
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
