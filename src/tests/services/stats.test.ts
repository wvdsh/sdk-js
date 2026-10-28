import { api } from "@wvdsh/api";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../../index";
import {
  StatsManager,
  STORE_THROTTLE_MS as THROTTLE_MS
} from "../../services/stats";

async function setup() {
  const responses: (() => void)[] = [];
  const mutation = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        responses.push(resolve);
      })
  );
  const subscriptions = new Map<string, (value: unknown) => void>();
  const emit = (ref: FunctionReference<"query">, value: unknown) =>
    subscriptions.get(getFunctionName(ref))!(value);
  const sdk = {
    gameCloudId: "cloud-1",
    convexClient: {
      mutation,
      query: vi.fn(async () => []),
      onUpdate: vi.fn(
        (
          ref: FunctionReference<"query">,
          _args: unknown,
          onValue: (value: unknown) => void
        ) => {
          subscriptions.set(getFunctionName(ref), onValue);
          return () => {};
        }
      )
    },
    gameEventManager: { notifyGame: vi.fn() }
  } as unknown as WavedashSDK;
  const manager = new StatsManager(sdk);
  emit(api.sdk.gameAchievements.listGameStatIdentifiers, ["kills", "deaths"]);
  emit(api.sdk.gameAchievements.listGameAchievementIdentifiers, [
    "first-blood"
  ]);
  emit(api.sdk.gameAchievements.getMyAchievementsForGame, []);
  await vi.advanceTimersByTimeAsync(0);

  const statSends = () =>
    mutation.mock.calls
      .map(
        (call) =>
          call as unknown as [FunctionReference<"mutation">, { stats: unknown }]
      )
      .filter(
        ([ref]) =>
          getFunctionName(ref) ===
          getFunctionName(api.sdk.gameAchievements.setUserGameStats)
      )
      .map(([, args]) => args.stats);
  return {
    manager,
    mutation,
    statSends,
    respondAll: async () => {
      for (const resolve of responses.splice(0)) resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
  };
}

let current: Awaited<ReturnType<typeof setup>>;

beforeEach(async () => {
  vi.useFakeTimers();
  current = await setup();
});

afterEach(() => {
  current.manager.destroy();
  vi.useRealTimers();
});

describe("StatsManager persist", () => {
  it("batches setStat calls into one send at the end of the window", async () => {
    const { manager, statSends } = current;

    manager.setStat("kills", 1);
    manager.setStat("kills", 2);
    manager.setStat("deaths", 1);
    expect(statSends()).toEqual([]);

    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(statSends()).toEqual([
      [
        { identifier: "kills", value: 2 },
        { identifier: "deaths", value: 1 }
      ]
    ]);
  });

  it("storeNow sends immediately", () => {
    const { manager, statSends } = current;

    manager.setStat("kills", 1, true);
    expect(statSends()).toEqual([[{ identifier: "kills", value: 1 }]]);
  });

  it("storeNow during an in-flight persist sends as soon as it settles", async () => {
    const { manager, statSends, respondAll } = current;

    manager.setStat("kills", 1, true);
    manager.setStat("kills", 2, true);
    expect(statSends()).toHaveLength(1);

    await respondAll();
    expect(statSends()).toEqual([
      [{ identifier: "kills", value: 1 }],
      [{ identifier: "kills", value: 2 }]
    ]);
  });

  it("never overlaps persists without storeNow", async () => {
    const { manager, statSends, respondAll } = current;

    manager.setStat("kills", 1);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    manager.setStat("kills", 2);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS * 5);
    expect(statSends()).toHaveLength(1);

    await respondAll();
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(statSends()).toHaveLength(2);
  });

  it("destroy cancels a queued persist", async () => {
    const { manager, mutation } = current;

    manager.setStat("kills", 1);
    manager.destroy();
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(mutation).not.toHaveBeenCalled();
  });
});
