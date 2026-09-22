import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";

function trackSdkCall(sdk: WavedashSDK, functionName: string): void {
  try {
    sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.SDK_FUNCTION_CALLED, {
      functionName
    });
  } catch {
    return;
  }
}

export function createTrackedSdk(sdk: WavedashSDK): WavedashSDK {
  const prototype = Object.getPrototypeOf(sdk) as object;

  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(prototype)
  )) {
    if (name === "constructor" || name.startsWith("_")) continue;
    if (typeof descriptor.value !== "function") continue;

    const original = descriptor.value as (
      this: WavedashSDK,
      ...args: unknown[]
    ) => unknown;

    Object.defineProperty(sdk, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: (...args: unknown[]) => {
        trackSdkCall(sdk, name);
        Object.defineProperty(sdk, name, {
          configurable: descriptor.configurable,
          enumerable: descriptor.enumerable,
          writable: descriptor.writable,
          value: original
        });
        return original.apply(sdk, args);
      }
    });
  }

  return sdk;
}
