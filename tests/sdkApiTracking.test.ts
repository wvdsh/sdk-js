import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../src/index";

const state = vi.hoisted(() => {
  const listFriends = vi.fn().mockResolvedValue([]);
  const getStat = vi.fn().mockReturnValue(7);
  const requestVolume = vi.fn().mockResolvedValue(true);
  class Manager {
    cacheUsers() {}
    destroy() {}
    init() {}
    flushEventQueue() {}
    listFriends = listFriends;
    getStat = getStat;
    requestVolume = requestVolume;
  }
  return { Manager, listFriends, getStat, requestVolume };
});

vi.mock("convex/browser", () => ({ ConvexClient: class {} }));
vi.mock("../src/services/auth", () => ({ AuthManager: state.Manager }));
vi.mock("../src/services/launchParams", () => ({
  LaunchParamManager: state.Manager
}));
vi.mock("../src/services/p2p", () => ({ P2PManager: state.Manager }));
vi.mock("../src/services/lobby", () => ({ LobbyManager: state.Manager }));
vi.mock("../src/services/stats", () => ({ StatsManager: state.Manager }));
vi.mock("../src/services/heartbeat", () => ({
  HeartbeatManager: state.Manager
}));
vi.mock("../src/services/fileSystem", () => ({
  FileSystemManager: state.Manager
}));
vi.mock("../src/services/ugc", () => ({ UGCManager: state.Manager }));
vi.mock("../src/services/leaderboards", () => ({
  LeaderboardManager: state.Manager
}));
vi.mock("../src/services/friends", () => ({ FriendsManager: state.Manager }));
vi.mock("../src/services/gameEvents", () => ({
  GameEventManager: state.Manager
}));
vi.mock("../src/services/fullscreen", () => ({
  FullscreenManager: state.Manager
}));
vi.mock("../src/services/audio", () => ({ AudioManager: state.Manager }));
vi.mock("../src/services/paidContent", () => ({
  PaidContentManager: state.Manager
}));
vi.mock("../src/services/externalLinks", () => ({
  ExternalLinkManager: state.Manager
}));
vi.mock("../src/utils/swMessenger", () => ({
  SwMessenger: class {
    addEventListener() {}
  }
}));

import { setupWavedashSDK } from "../src/index";

let sdk: WavedashSDK;
let post: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, "__wavedashSdkConfig", {
    configurable: true,
    value: JSON.stringify({
      convexCloudUrl: "https://example.convex.cloud",
      parentOrigin: "https://wavedash.lvh.me",
      gameCloudId: "test-game",
      wavedashUser: { id: "test-user", username: "player" },
      launchParams: {}
    })
  });
  sdk = setupWavedashSDK();
  post = vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).Wavedash;
  delete (window as unknown as Record<string, unknown>).WavedashJS;
  delete (window as unknown as Record<string, unknown>).__wavedashSdkConfig;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function calls() {
  return post.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "SdkFunctionCalled");
}

describe("SDK entry point tracking", () => {
  it("tracks async helper calls while preserving response envelopes", async () => {
    expect(await sdk.listFriends()).toEqual({ success: true, data: [] });
    expect(calls()).toEqual([
      {
        type: "SdkFunctionCalled",
        functionName: "listFriends",
        gameCloudId: "test-game"
      }
    ]);
  });

  it("tracks sync helper calls while preserving raw return values", () => {
    expect(sdk.getStat("score")).toBe(7);
    expect(calls()).toEqual([
      {
        type: "SdkFunctionCalled",
        functionName: "getStat",
        gameCloudId: "test-game"
      }
    ]);
  });

  it("records rejected validation attempts without leaking arguments", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => sdk.getStat(42 as unknown as string)).toThrow();
    expect(calls()).toEqual([
      {
        type: "SdkFunctionCalled",
        functionName: "getStat",
        gameCloudId: "test-game"
      }
    ]);
  });

  it("tracks the new volume method outside the response-envelope helpers", async () => {
    expect(await sdk.requestVolume(0.35)).toBe(true);
    expect(state.requestVolume).toHaveBeenLastCalledWith(0.35);
    expect(calls()).toEqual([
      {
        type: "SdkFunctionCalled",
        functionName: "requestVolume",
        gameCloudId: "test-game"
      }
    ]);
  });

  it("preserves a failed async call response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    state.listFriends.mockRejectedValueOnce(new Error("offline"));
    expect(await sdk.listFriends()).toEqual({
      success: false,
      data: null,
      message: "offline"
    });
    expect(calls()).toHaveLength(1);
  });

  it("does not change successful SDK behavior when tracking fails", async () => {
    post.mockImplementation(() => {
      throw new Error("postMessage unavailable");
    });
    expect(await sdk.listFriends()).toEqual({ success: true, data: [] });
    expect(sdk.getStat("score")).toBe(7);
  });
});
