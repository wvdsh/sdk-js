import { api } from "@wvdsh/api";
import { getFunctionName, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../../index";
import { P2PManager } from "../../services/p2p";
import { TurnCredentialsManager } from "../../services/turnCredentials";

const HOUR_MS = 60 * 60 * 1000;
const ICE_SERVERS = [
  { urls: ["turn:turn.test:3478"], username: "user", credential: "secret" }
];

type Credentials = { iceServers: typeof ICE_SERVERS; expiresAt: number };

function setup(ensureFresh: () => Promise<boolean>) {
  let onValue: ((value: Credentials | null) => void) | undefined;
  let onError: ((error: Error) => void) | undefined;
  const unsubscribe = vi.fn();
  const mutation = vi.fn((_ref: FunctionReference<"mutation">) =>
    ensureFresh()
  );
  const onUpdate = vi.fn(
    (
      _ref: FunctionReference<"query">,
      _args: unknown,
      value: (value: Credentials | null) => void,
      error: (error: Error) => void
    ) => {
      onValue = value;
      onError = error;
      return unsubscribe;
    }
  );
  const sdk = {
    convexClient: { mutation, onUpdate }
  } as unknown as WavedashSDK;
  const manager = new TurnCredentialsManager(sdk);
  return {
    sdk,
    manager,
    getIceServers: () => manager.getIceServers(),
    mutation,
    onUpdate,
    unsubscribe,
    emit: (value: Credentials | null) => onValue!(value),
    emitError: (error: Error) => onError!(error)
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TurnCredentialsManager", () => {
  it("uses subscribed credentials without calling the mutation", async () => {
    const { getIceServers, mutation, onUpdate, emit } = setup(async () => true);

    const pending = getIceServers();
    expect(getFunctionName(onUpdate.mock.calls[0][0])).toBe(
      getFunctionName(api.sdk.turnCredentials.get)
    );
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 2 * HOUR_MS });

    expect(await pending).toEqual(ICE_SERVERS);
    expect(await getIceServers()).toEqual(ICE_SERVERS);
    expect(mutation).not.toHaveBeenCalled();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("asks for credentials once when there are none and waits for the subscription", async () => {
    const { getIceServers, mutation, emit } = setup(async () => true);

    const first = getIceServers();
    const second = getIceServers();
    emit(null);
    await vi.advanceTimersByTimeAsync(0);

    expect(mutation).toHaveBeenCalledTimes(1);
    expect(getFunctionName(mutation.mock.calls[0][0])).toBe(
      getFunctionName(api.sdk.turnCredentials.ensureFresh)
    );

    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 24 * HOUR_MS });
    expect(await first).toEqual(ICE_SERVERS);
    expect(await second).toEqual(ICE_SERVERS);
  });

  it("waits for newer credentials when the current ones are close to expiring", async () => {
    const { getIceServers, mutation, emit } = setup(async () => true);
    const stale = [{ urls: ["turn:stale.test:3478"] }];
    const expiring = Date.now() + HOUR_MS / 2;

    const pending = getIceServers();
    emit({ iceServers: stale, expiresAt: expiring });
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).toHaveBeenCalledTimes(1);

    // A repeat of what we already have is not the refresh
    emit({ iceServers: stale, expiresAt: expiring });
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 24 * HOUR_MS });
    expect(await pending).toEqual(ICE_SERVERS);
  });

  it("uses what it has when the backend says nothing needs generating", async () => {
    const { getIceServers, mutation, emit } = setup(async () => false);

    const pending = getIceServers();
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + HOUR_MS / 2 });

    expect(await pending).toEqual(ICE_SERVERS);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("returns null when generated credentials never arrive, then retries on the next call", async () => {
    const { getIceServers, mutation, emit } = setup(async () => true);

    let result: RTCIceServer[] | null | undefined;
    void getIceServers().then((value) => (result = value));
    emit(null);
    await vi.advanceTimersByTimeAsync(15_000 - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBeNull();

    const retry = getIceServers();
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).toHaveBeenCalledTimes(2);
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 24 * HOUR_MS });
    expect(await retry).toEqual(ICE_SERVERS);
  });

  it("returns null when the subscription never responds", async () => {
    const { getIceServers, mutation } = setup(async () => true);

    const pending = getIceServers();
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toBeNull();
    expect(mutation).not.toHaveBeenCalled();
  });

  it("returns null when the mutation never settles", async () => {
    const { getIceServers, emit } = setup(() => new Promise(() => {}));

    const pending = getIceServers();
    emit(null);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toBeNull();
  });

  it("resubscribes and retries after a subscription error", async () => {
    const { getIceServers, onUpdate, unsubscribe, emit, emitError } = setup(
      async () => true
    );

    const pending = getIceServers();
    emitError(new Error("Not authenticated"));
    // The old subscription won't report anything again; the retry must not
    // wait on it.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 2 * HOUR_MS });
    expect(await pending).toEqual(ICE_SERVERS);
  });

  it("retries a failing mutation with backoff, then gives up at the deadline", async () => {
    const { getIceServers, mutation, emit } = setup(async () => {
      throw new Error("Server Error");
    });

    let result: RTCIceServer[] | null | undefined;
    void getIceServers().then((value) => (result = value));
    emit(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mutation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mutation).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(result).toBeNull();
    const attempts = mutation.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mutation).toHaveBeenCalledTimes(attempts);
  });

  it("keeps credentials it already has when a refresh fails", async () => {
    const { getIceServers, emit } = setup(async () => {
      throw new Error("Server Error");
    });

    const pending = getIceServers();
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + HOUR_MS / 2 });
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await pending).toEqual(ICE_SERVERS);
  });

  it("doesn't resubscribe when destroyed during backoff", async () => {
    const { manager, getIceServers, onUpdate, emitError } = setup(
      async () => true
    );

    const pending = getIceServers();
    emitError(new Error("Not authenticated"));
    await vi.advanceTimersByTimeAsync(0);
    manager.destroy();

    expect(await pending).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it("settles and stops when destroyed mid-refresh", async () => {
    let finishMutation!: (generating: boolean) => void;
    const { manager, getIceServers, onUpdate, mutation, emit } = setup(
      () => new Promise((resolve) => (finishMutation = resolve))
    );

    const pending = getIceServers();
    emit(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).toHaveBeenCalledTimes(1);
    manager.destroy();
    finishMutation(true);

    expect(await pending).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on destroy", async () => {
    const { manager, getIceServers, unsubscribe, emit } = setup(
      async () => true
    );

    const pending = getIceServers();
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 2 * HOUR_MS });
    await pending;
    manager.destroy();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("P2PManager TURN credentials", () => {
  it("doesn't subscribe or generate until P2P needs ICE servers", () => {
    const { sdk, mutation, onUpdate } = setup(async () => true);

    const p2p = new P2PManager(sdk);
    p2p.init();
    p2p.destroy();

    expect(onUpdate).not.toHaveBeenCalled();
    expect(mutation).not.toHaveBeenCalled();
  });
});
