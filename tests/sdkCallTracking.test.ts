import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IFrameMessenger } from "../src/utils/iframeMessenger";
import { setParentOrigin } from "../src/utils/parentOrigin";
import { trackSdkCall } from "../src/utils/sdkCallTracking";

const origin = "https://wavedash.lvh.me";
let messenger: IFrameMessenger;

beforeEach(() => {
  setParentOrigin(origin);
  messenger = new IFrameMessenger();
});

afterEach(() => {
  window.removeEventListener(
    "message",
    (messenger as unknown as { handleMessage: EventListener }).handleMessage
  );
  setParentOrigin("");
  vi.restoreAllMocks();
});

describe("SDK call telemetry", () => {
  it("sends each invocation to the configured host without arguments", () => {
    const post = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation(() => {});
    trackSdkCall(messenger, "requestMute", "game-cloud-id");
    trackSdkCall(messenger, "requestMute", "game-cloud-id");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(
      {
        type: "SdkFunctionCalled",
        functionName: "requestMute",
        gameCloudId: "game-cloud-id"
      },
      origin
    );
  });

  it.each([
    ["getMaxPayloadSize", "getP2PMaxPayloadSize"],
    ["getMaxIncomingMessages", "getP2PMaxIncomingMessages"],
    ["getOutgoingMessageBuffer", "getP2POutgoingMessageBuffer"],
    ["getHostId", "getLobbyHostId"]
  ])("uses the public name for %s", (method, functionName) => {
    const post = vi.spyOn(messenger, "postToParent").mockReturnValue(true);
    trackSdkCall(messenger, method, "game-cloud-id");
    expect(post).toHaveBeenCalledWith("SdkFunctionCalled", {
      functionName,
      gameCloudId: "game-cloud-id"
    });
  });

  it("does not send standalone calls to an unrelated parent", () => {
    setParentOrigin("");
    const post = vi.spyOn(window.parent, "postMessage");
    trackSdkCall(messenger, "requestVolume", "game-cloud-id");
    expect(post).not.toHaveBeenCalled();
  });

  it("never lets telemetry errors interrupt a game", () => {
    vi.spyOn(messenger, "postToParent").mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() =>
      trackSdkCall(messenger, "getUserJwt", "game-cloud-id")
    ).not.toThrow();
  });
});
