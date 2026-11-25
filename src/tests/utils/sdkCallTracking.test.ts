import { SDK_FEATURE } from "@wvdsh/api";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WavedashEvents } from "../../events";
import type { WavedashSDK } from "../../index";

class FakeSdk {
  iframeMessenger = { postToParent: vi.fn() };
  convexClient = {
    mutation: vi.fn((): Promise<null> => Promise.resolve(null))
  };
  createLobby() {
    return "lobby1";
  }
  joinLobby() {}
  getLobbyUsers() {}
  sendP2PMessage(...args: unknown[]) {
    return args;
  }
  getP2PMaxPayloadSize() {}
  getP2PMaxIncomingMessages() {}
  getP2POutgoingMessageBuffer() {}
  listUGCItems() {}
  uploadRemoteFile() {}
  downloadRemoteFile() {}
  getUser() {
    return this;
  }
}

type Tracking = typeof import("../../utils/sdkCallTracking");

let tracking: Tracking;
let fake: FakeSdk;
let sdk: FakeSdk;

function recordedFeatures(): unknown[] {
  return fake.convexClient.mutation.mock.calls.map((call: unknown[]) => {
    expect(getFunctionName(call[0] as FunctionReference<"mutation">)).toBe(
      "sdk/featureUsage:recordFeatureUsage"
    );
    return (call[1] as { feature: unknown }).feature;
  });
}

beforeEach(async () => {
  vi.resetModules();
  tracking = await import("../../utils/sdkCallTracking");
  fake = new FakeSdk();
  sdk = tracking.createTrackedSdk(
    fake as unknown as WavedashSDK
  ) as unknown as FakeSdk;
});

describe("SDK feature usage tracking", () => {
  it("records a feature once per session however many of its functions run", () => {
    expect(sdk.createLobby()).toBe("lobby1");
    sdk.createLobby();
    sdk.joinLobby();
    sdk.getLobbyUsers();

    expect(recordedFeatures()).toEqual([SDK_FEATURE.LOBBY]);
  });

  it("does not count reading a function the game never calls", () => {
    const { createLobby, joinLobby } = sdk;
    const listUGCItems = sdk.listUGCItems.bind(sdk);
    expect(typeof sdk.sendP2PMessage).toBe("function");
    expect([createLobby, joinLobby, listUGCItems]).toHaveLength(3);

    expect(recordedFeatures()).toEqual([]);
    expect(fake.iframeMessenger.postToParent).not.toHaveBeenCalled();
  });

  it("records the first call through a reference read earlier and passes arguments through", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const send = sdk.sendP2PMessage;

    expect(send("user1", 2, false, payload)).toEqual([
      "user1",
      2,
      false,
      payload
    ]);
    expect(send("user2")).toEqual(["user2"]);
    expect(sdk.sendP2PMessage("user3")).toEqual(["user3"]);

    expect(recordedFeatures()).toEqual([SDK_FEATURE.P2P]);
    expect(fake.iframeMessenger.postToParent).toHaveBeenCalledTimes(1);
  });

  it("swaps in the SDK-bound function after the first call", () => {
    const beforeCall = sdk.getUser;
    expect(beforeCall()).toBe(fake);

    const afterCall = sdk.getUser;
    expect(afterCall).not.toBe(beforeCall);
    expect(afterCall()).toBe(fake);
    expect(fake.iframeMessenger.postToParent).toHaveBeenCalledTimes(1);
  });

  it("records lobby, P2P, and UGC separately", () => {
    sdk.joinLobby();
    sdk.sendP2PMessage();
    sdk.listUGCItems();

    expect(recordedFeatures()).toEqual([
      SDK_FEATURE.LOBBY,
      SDK_FEATURE.P2P,
      SDK_FEATURE.UGC
    ]);
  });

  it("ignores P2P config getters, cloud saves, other functions, and event listeners", () => {
    sdk.getP2PMaxPayloadSize();
    sdk.getP2PMaxIncomingMessages();
    sdk.getP2POutgoingMessageBuffer();
    sdk.uploadRemoteFile();
    sdk.downloadRemoteFile();
    sdk.getUser();
    tracking.trackSdkEventListener(
      sdk as unknown as WavedashSDK,
      WavedashEvents.LOBBY_JOINED
    );
    tracking.trackSdkEventListener(
      sdk as unknown as WavedashSDK,
      WavedashEvents.P2P_CONNECTION_ESTABLISHED
    );

    expect(recordedFeatures()).toEqual([]);
    expect(fake.iframeMessenger.postToParent).toHaveBeenCalledTimes(8);
  });

  it("tries again on the next function in the feature after a failed send", async () => {
    fake.convexClient.mutation.mockImplementationOnce(() =>
      Promise.reject(new Error("offline"))
    );

    sdk.createLobby();
    await new Promise((resolve) => setTimeout(resolve));
    sdk.joinLobby();
    sdk.getLobbyUsers();

    expect(recordedFeatures()).toEqual([SDK_FEATURE.LOBBY, SDK_FEATURE.LOBBY]);
  });

  it("still records when the analytics post to the parent fails", () => {
    fake.iframeMessenger.postToParent.mockImplementation(() => {
      throw new Error("no parent");
    });

    expect(sdk.createLobby()).toBe("lobby1");
    expect(recordedFeatures()).toEqual([SDK_FEATURE.LOBBY]);
  });
});
