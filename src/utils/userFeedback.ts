export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Unknown error.";
}

export function showOperationError(title: string, error: unknown): void {
  const message = `${title}\n\n${extractErrorMessage(error)}`;
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message);
  }
}
