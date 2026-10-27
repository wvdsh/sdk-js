import { api } from "@wvdsh/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../../index";
import { HeartbeatManager } from "../../services/heartbeat";

const THROTTLE_MS = 1_000;

function setup() {
  const responses: {
    resolve: (accepted: boolean) => void;
    reject: (error: Error) => void;
  }[] = [];
  const mutation = vi.fn(
    () =>
      new Promise<boolean>((resolve, reject) => {
        responses.push({ resolve, reject });
      })
  );
  const sdk = {
    convexClient: {
      mutation,
      client: { connectionState: () => ({ isWebSocketConnected: true }) }
    },
    pageViewId: "page-view-1",
    gameLoaded: false
  } as unknown as WavedashSDK;
  const manager = new HeartbeatManager(sdk);
  const sentData = () =>
    mutation.mock.calls.map(
      (call) => (call as unknown as [unknown, { data: unknown }])[1].data
    );
  return {
    manager,
    mutation,
    sentData,
    respond: async (accepted: boolean) => {
      responses.shift()!.resolve(accepted);
      await vi.advanceTimersByTimeAsync(0);
    },
    fail: async () => {
      responses.shift()!.reject(new Error("network"));
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

let current: ReturnType<typeof setup>;

beforeEach(() => {
  vi.useFakeTimers();
  current = setup();
});

afterEach(() => {
  current.manager.destroy();
  vi.useRealTimers();
});

describe("HeartbeatManager.updateUserPresence", () => {
  it("sends the first update immediately as a presence heartbeat", async () => {
    const { manager, mutation, respond } = current;

    const result = manager.updateUserPresence({ level: 1 });
    expect(mutation).toHaveBeenCalledWith(api.sdk.presence.heartbeat, {
      data: { level: 1 },
      deviceFingerprint: undefined,
      pageViewId: "page-view-1"
    });

    await respond(true);
    await expect(result).resolves.toBe(true);
  });

  it("coalesces rapid updates into one send of the latest data", async () => {
    const { manager, sentData, respond } = current;

    const first = manager.updateUserPresence({ level: 1 });
    const second = manager.updateUserPresence({ level: 2 });
    const third = manager.updateUserPresence({ level: 3 });
    expect(sentData()).toEqual([{ level: 1 }]);

    await respond(true);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(sentData()).toEqual([{ level: 1 }, { level: 3 }]);

    await respond(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await expect(third).resolves.toBe(true);
  });

  it("sends at most once per throttle window", async () => {
    const { manager, mutation, sentData } = current;
    mutation.mockImplementation(() => Promise.resolve(true));

    for (let level = 1; level <= 30; level++) {
      void manager.updateUserPresence({ level });
      await vi.advanceTimersByTimeAsync(THROTTLE_MS / 10);
    }
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    expect(sentData().length).toBeLessThanOrEqual(4);
    expect(sentData().at(-1)).toEqual({ level: 30 });
  });

  it("skips an update identical to the last accepted one", async () => {
    const { manager, mutation, respond } = current;

    void manager.updateUserPresence({ level: 1 });
    await respond(true);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    await expect(manager.updateUserPresence({ level: 1 })).resolves.toBe(true);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe against the last accepted data while a different update is queued", async () => {
    const { manager, sentData, respond } = current;

    void manager.updateUserPresence({ level: 1 });
    await respond(true);
    void manager.updateUserPresence({ level: 2 });
    void manager.updateUserPresence({ level: 1 });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    expect(sentData()).toEqual([{ level: 1 }, { level: 1 }]);
  });

  it("resends identical data after the backend rejected it", async () => {
    const { manager, sentData, respond } = current;

    const rejected = manager.updateUserPresence({ level: 1 });
    await respond(false);
    await expect(rejected).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    void manager.updateUserPresence({ level: 1 });
    expect(sentData()).toEqual([{ level: 1 }, { level: 1 }]);
  });

  it("resolves false when the mutation errors", async () => {
    const { manager, fail } = current;

    const result = manager.updateUserPresence({ level: 1 });
    await fail();
    await expect(result).resolves.toBe(false);
  });

  it("snapshots data so later caller mutations don't change what was sent", async () => {
    const { manager, sentData } = current;

    const data = { level: 1 };
    void manager.updateUserPresence(data);
    data.level = 2;
    expect(sentData()).toEqual([{ level: 1 }]);
  });
});
