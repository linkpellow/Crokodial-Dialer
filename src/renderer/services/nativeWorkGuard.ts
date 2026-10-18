let pendingWork: (() => boolean) | undefined;
export function registerNativeWorkGuard(check: () => boolean): () => void {
  pendingWork = check;
  return () => { if (pendingWork === check) pendingWork = undefined; };
}
export function nativeWorkSessionNotice(): string | null {
  return pendingWork?.() ? 'Your session ended before pending notes, audio or assistant work could be saved. Saved platform work is available after you sign in; unsaved local work was cleared to protect your account.' : null;
}
