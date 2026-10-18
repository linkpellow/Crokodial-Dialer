import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

export interface NativeWorkState { dirty: boolean; busy: boolean }
const noop = (_state: NativeWorkState) => {};
const NativeWorkStateContext = createContext<(state: NativeWorkState) => void>(noop);

/** A stable reporter prevents parent rerenders from retriggering child state notifications. */
export function NativeWorkStateProvider({ children, onStateChange }: { children: ReactNode; onStateChange?: (state: NativeWorkState) => void }) {
  const callback = useRef(onStateChange); callback.current = onStateChange;
  const report = useCallback((state: NativeWorkState) => callback.current?.(state), []);
  useLayoutEffect(() => () => callback.current?.({ dirty: false, busy: false }), []);
  return <NativeWorkStateContext.Provider value={report}>{children}</NativeWorkStateContext.Provider>;
}
export function useNativeWorkState(dirty: boolean, busy: boolean) {
  const report = useContext(NativeWorkStateContext);
  useLayoutEffect(() => { report({ dirty, busy }); }, [report, dirty, busy]);
}

/** In-editor navigation uses an inline choice, never an OS dialog or silent discard. */
export function useNativeDiscardGuard(dirty: boolean, busy: boolean) {
  const [pending, setPending] = useState<(() => void) | null>(null);
  function guard(action: () => void) {
    if (busy) return;
    if (dirty) setPending(() => action); else action();
  }
  const notice = pending && <div role="alertdialog" aria-label="Unsaved editor changes" className="nativework-panel nativework-stack">
    <p>You have unsaved changes. Keep editing or discard them before opening another item.</p>
    <div className="nativework-row"><button type="button" onClick={() => setPending(null)}>Keep editing</button><button type="button" onClick={() => { setPending(null); pending(); }}>Discard and continue</button></div>
  </div>;
  return { guard, notice };
}
