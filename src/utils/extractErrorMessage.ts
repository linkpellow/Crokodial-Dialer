/**
 * Extract a human-readable error message from unknown error values.
 * Prevents [object Object] and raw objects from reaching the UI.
 * @param defaultMessage - Fallback when no readable message can be extracted.
 */
export function extractErrorMessage(err: unknown, defaultMessage = 'An error occurred'): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  if (typeof err === 'string') return err;
  return defaultMessage;
}
