import type { WavedashSDK } from "../index";

const reportedFunctions = new WeakMap<WavedashSDK, Set<string>>();

export function trackSdkCall(sdk: WavedashSDK, functionName: string): void {
  try {
    let reported = reportedFunctions.get(sdk);
    if (!reported) {
      reported = new Set();
      reportedFunctions.set(sdk, reported);
    }
    if (reported.has(functionName)) return;
    reported.add(functionName);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore Pending shared API message types.
    sdk.iframeMessenger.postToParent("SdkFunctionCalled", {
      functionName
    });
  } catch {
    return;
  }
}
