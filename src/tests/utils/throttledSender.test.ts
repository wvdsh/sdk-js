import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottledSender } from "../../utils/throttledSender";

const WAIT_MS = 1_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(leading: boolean) {
  let pending = 0;
  const inFlight: ReturnType<typeof deferred>[] = [];
  const sent: number[] = [];
  const send = vi.fn(() => {
    sent.push(pending);
    pending = 0;
    const d = deferred();
    inFlight.push(d);
    return d.promise;
  });
  const sender = createThrottledSender({
    waitMs: WAIT_MS,
    leading,
    hasPending: () => pending > 0,
    send
  });
  return {
    sender,
    send,
    sent,
    queue: () => {
      pending++;
      sender.schedule();
    },
    settle: async () => {
      inFlight.shift()!.resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createThrottledSender", () => {
  it("sends immediately with leading: true and coalesces the rest of the window", async () => {
    const { send, sent, queue, settle } = setup(true);

    queue();
    expect(send).toHaveBeenCalledTimes(1);
    await settle();

    queue();
    queue();
    queue();
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(sent).toEqual([1, 3]);
  });

  it("waits out the window with leading: false", async () => {
    const { send, sent, queue } = setup(false);

    queue();
    queue();
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(sent).toEqual([2]);
  });

  it("never overlaps sends, and sends what queued during flight once it settles", async () => {
    const { send, sent, queue, settle } = setup(true);

    queue();
    queue();
    await vi.advanceTimersByTimeAsync(WAIT_MS * 5);
    expect(send).toHaveBeenCalledTimes(1);

    await settle();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(sent).toEqual([1, 1]);
  });

  it("does not send when nothing is pending", async () => {
    const { sender, send } = setup(true);

    sender.schedule();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("flush sends a queued update now instead of at the end of the window", async () => {
    const { sender, sent, queue } = setup(false);

    queue();
    sender.flush();
    expect(sent).toEqual([1]);
  });

  it("a flush that hits the in-flight gate sends as soon as the send settles", async () => {
    const { sender, sent, queue, settle } = setup(false);

    queue();
    sender.flush();
    queue();
    sender.flush();
    expect(sent).toEqual([1]);

    await settle();
    expect(sent).toEqual([1, 1]);
  });

  it("cancel drops a queued trailing send", async () => {
    const { sender, send, queue } = setup(false);

    queue();
    sender.cancel();
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
