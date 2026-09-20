import type { IFrameMessenger } from "./iframeMessenger";

const TELEMETRY_INTERVAL_MS = 1_000;
const lastSentByMessenger = new WeakMap<IFrameMessenger, Map<string, number>>();

export function trackSdkCall(
  messenger: IFrameMessenger,
  functionName: string
): void {
  try {
    let lastSent = lastSentByMessenger.get(messenger);
    if (!lastSent) {
      lastSent = new Map();
      lastSentByMessenger.set(messenger, lastSent);
    }
    const now = performance.now();
    const previous = lastSent.get(functionName);
    if (previous !== undefined && now - previous < TELEMETRY_INTERVAL_MS)
      return;
    lastSent.set(functionName, now);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore Pending shared API message types.
    messenger.postToParent("SdkFunctionCalled", {
      functionName
    });
  } catch {
    return;
  }
}
