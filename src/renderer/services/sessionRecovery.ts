/** Only session reads are retried. Actions must never use this recovery loop. */
export class SessionConnectionError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

export function startSessionRecovery(options: {
  check: (signal: AbortSignal) => Promise<boolean>;
  restored: (valid: boolean) => void;
  failed: (error: unknown, retryScheduled: boolean) => void;
  retryDelays?: readonly number[];
}) {
  const delays = options.retryDelays ?? [1000, 3000, 10000];
  const controller = new AbortController();
  let cancelled = false, checking = false, failed = false, retryIndex = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = async () => {
    if (cancelled || checking) return;
    checking = true;
    try {
      const valid = await options.check(controller.signal);
      if (!cancelled) { failed = false; options.restored(valid); }
    } catch (error) {
      if (cancelled) return;
      failed = error instanceof SessionConnectionError && error.retryable;
      const retryScheduled = failed && retryIndex < delays.length;
      if (retryScheduled) timer = setTimeout(() => { timer = undefined; void check(); }, delays[retryIndex++]);
      options.failed(error, retryScheduled);
    } finally { checking = false; }
  };
  void check();
  return {
    retry() {
      if (cancelled || checking || !failed) return;
      clearTimeout(timer); timer = undefined; retryIndex = 0;
      void check();
    },
    cancel() { cancelled = true; controller.abort(); clearTimeout(timer); },
  };
}
