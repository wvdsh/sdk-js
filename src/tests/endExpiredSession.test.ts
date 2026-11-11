import { api } from "@wvdsh/api";
import type { ConnectionState } from "convex/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../index";

class SilentWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SilentWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  send(): void {}
  close(): void {
    this.readyState = SilentWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "" });
  }
}

let sdk: WavedashSDK;

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal("WebSocket", SilentWebSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {}))
  );
  Object.assign(window, {
    Wavedash: undefined,
    __wavedashSdkConfig: JSON.stringify({
      convexCloudUrl: "https://example.convex.cloud",
      wavedashUser: { id: "user1", username: "player" },
      gameCloudId: "cloud1",
      ugcHost: "ugc.example.com",
      uploadsHost: "uploads.example.com",
      staticHost: "static.example.com",
      launchParams: {},
      parentOrigin: "https://wavedash.example.com",
      initialVolume: 1
    })
  });
  const { setupWavedashSDK } = await import("../index");
  sdk = setupWavedashSDK();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WavedashSDK._endExpiredSession", () => {
  it("swaps in a disabled client so later calls never reach the server", async () => {
    const expired = sdk.convexClient;
    const close = vi.spyOn(expired, "close");

    sdk._endExpiredSession();

    expect(sdk.convexClient).not.toBe(expired);
    expect(sdk.convexClient.disabled).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(
      sdk.convexClient.mutation(api.sdk.presence.heartbeat, { data: {} })
    ).rejects.toThrow("ConvexClient is disabled");
    await expect(
      sdk.convexClient.query(api.sdk.gameAchievements.getMyStatsForGame, {})
    ).rejects.toThrow("ConvexClient is disabled");

    sdk._endExpiredSession();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the expired client only once its in-flight requests settle", () => {
    const expired = sdk.convexClient;
    const close = vi.spyOn(expired, "close");
    let hasInflightRequests = true;
    vi.spyOn(expired, "connectionState").mockImplementation(
      () => ({ hasInflightRequests }) as ConnectionState
    );
    let notify: (() => void) | null = null;
    const unsubscribe = vi.fn();
    vi.spyOn(expired, "subscribeToConnectionState").mockImplementation((cb) => {
      notify = () => cb(expired.connectionState());
      return unsubscribe;
    });

    sdk._endExpiredSession();
    expect(sdk.convexClient.disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();

    notify!();
    expect(close).not.toHaveBeenCalled();

    hasInflightRequests = false;
    notify!();
    expect(close).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
