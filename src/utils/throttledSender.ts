import throttle from "lodash.throttle";

/**
 * Throttled send loop with a single in-flight gate, so rapid writes coalesce
 * and never overlap into OCC self-conflicts. The caller owns the pending
 * state: `send` drains it and must not reject, and anything queued while a
 * send is in flight goes out once it settles.
 */
export function createThrottledSender({
  waitMs,
  leading,
  hasPending,
  send
}: {
  waitMs: number;
  leading: boolean;
  hasPending: () => boolean;
  send: () => Promise<void>;
}) {
  let inFlight = false;
  // lodash counts a flush swallowed by the in-flight gate as an invocation, so
  // remember it and flush again once the send settles
  let flushRequested = false;

  const run = (): void => {
    if (inFlight || !hasPending()) return;
    inFlight = true;
    void send().finally(() => {
      inFlight = false;
      const shouldFlushNow = flushRequested;
      flushRequested = false;
      if (!hasPending()) return;
      throttled();
      if (shouldFlushNow) throttled.flush();
    });
  };

  const throttled = throttle(run, waitMs, { leading, trailing: true });

  return {
    schedule: (): void => {
      throttled();
    },
    flush: (): void => {
      if (inFlight) flushRequested = true;
      throttled.flush();
    },
    cancel: (): void => {
      throttled.cancel();
    }
  };
}
