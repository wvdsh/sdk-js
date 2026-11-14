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

  it("rejects when generated credentials never arrive, then retries on the next call", async () => {
    const { getIceServers, mutation, emit } = setup(async () => true);

    const pending = getIceServers();
    const rejection = expect(pending).rejects.toThrow(
      "Timed out waiting for TURN credentials"
    );
    emit(null);
    await vi.advanceTimersByTimeAsync(15_000);
    await rejection;

    const retry = getIceServers();
    await vi.advanceTimersByTimeAsync(0);
    expect(mutation).toHaveBeenCalledTimes(2);
    emit({ iceServers: ICE_SERVERS, expiresAt: Date.now() + 24 * HOUR_MS });
    expect(await retry).toEqual(ICE_SERVERS);
  });

  it("rejects when the subscription errors", async () => {
    const { getIceServers, emitError } = setup(async () => true);

    const pending = getIceServers();
    emitError(new Error("Not authenticated"));

    await expect(pending).rejects.toThrow("Not authenticated");
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
