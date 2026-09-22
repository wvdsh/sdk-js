import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashEvents } from "../events";
import type { WavedashSDK } from "../index";

const wavedashEventNames = new Set<string>(Object.values(WavedashEvents));
const reportedEvents = new Set<string>();

export function trackSdkEventListener(
  sdk: WavedashSDK,
  eventName: string
): void {
  if (!wavedashEventNames.has(eventName) || reportedEvents.has(eventName)) {
    return;
  }
  reportedEvents.add(eventName);
  trackSdkCall(sdk, `on${eventName}`);
}

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

    const original = (
      descriptor.value as (this: WavedashSDK, ...args: unknown[]) => unknown
    ).bind(sdk);

    const install = (value: unknown) => {
      Object.defineProperty(sdk, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: true,
        value
      });
    };

    Object.defineProperty(sdk, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        install(original);
        trackSdkCall(sdk, name);
        return original;
      },
      set: install
    });
  }

  return sdk;
}
