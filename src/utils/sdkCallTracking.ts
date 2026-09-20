import { IFRAME_MESSAGE_TYPE } from "./iframeMessages";
import type { IFrameMessenger } from "./iframeMessenger";

const TELEMETRY_INTERVAL_MS = 1_000;
const lastSentByMessenger = new WeakMap<IFrameMessenger, Map<string, number>>();

export function trackSdkCall(
  messenger: IFrameMessenger,
  functionName: string,
  gameCloudId: string
): void {
  try {
    const key = `${gameCloudId}:${functionName}`;
    let lastSent = lastSentByMessenger.get(messenger);
    if (!lastSent) {
      lastSent = new Map();
      lastSentByMessenger.set(messenger, lastSent);
    }
    const now = performance.now();
    const previous = lastSent.get(key);
    if (previous !== undefined && now - previous < TELEMETRY_INTERVAL_MS)
      return;
    lastSent.set(key, now);
    messenger.postToParent(IFRAME_MESSAGE_TYPE.SDK_FUNCTION_CALLED, {
      functionName,
      gameCloudId
    });
  } catch {
    return;
  }
}
