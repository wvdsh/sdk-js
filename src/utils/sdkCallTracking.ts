import { IFRAME_MESSAGE_TYPE } from "./iframeMessages";
import type { IFrameMessenger } from "./iframeMessenger";

const publicNames: Record<string, string> = {
  getMaxPayloadSize: "getP2PMaxPayloadSize",
  getMaxIncomingMessages: "getP2PMaxIncomingMessages",
  getOutgoingMessageBuffer: "getP2POutgoingMessageBuffer",
  getHostId: "getLobbyHostId"
};

export function trackSdkCall(
  messenger: IFrameMessenger,
  method: string,
  gameCloudId: string
): void {
  try {
    messenger.postToParent(IFRAME_MESSAGE_TYPE.SDK_FUNCTION_CALLED, {
      functionName: publicNames[method] ?? method,
      gameCloudId
    });
  } catch {
    return;
  }
}
