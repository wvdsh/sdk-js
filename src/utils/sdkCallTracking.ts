import type { WavedashSDK } from "../index";

const reportedFunctions = new WeakMap<WavedashSDK, Set<string>>();

function trackSdkCall(sdk: WavedashSDK, functionName: string): void {
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

export function createTrackedSdk(sdk: WavedashSDK): WavedashSDK {
  const prototype = Object.getPrototypeOf(sdk);
  const publicSdk: WavedashSDK = Object.setPrototypeOf(
    new EventTarget(),
    prototype
  );

  for (const name of [
    "addEventListener",
    "removeEventListener",
    "dispatchEvent"
  ] as const) {
    Object.defineProperty(sdk, name, {
      configurable: true,
      writable: true,
      value: EventTarget.prototype[name].bind(publicSdk)
    });
  }

  const descriptors = {
    ...Object.getOwnPropertyDescriptors(prototype),
    ...Object.getOwnPropertyDescriptors(sdk)
  };

  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (name === "constructor") continue;
    const tracked = !name.startsWith("_");

    if (typeof descriptor.value === "function") {
      Object.defineProperty(publicSdk, name, {
        ...descriptor,
        value: (...args: unknown[]) => {
          if (tracked) trackSdkCall(sdk, name);
          return Reflect.apply(Reflect.get(sdk, name), sdk, args);
        }
      });
    } else {
      Object.defineProperty(publicSdk, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        get() {
          if (tracked && descriptor.get) trackSdkCall(sdk, name);
          return Reflect.get(sdk, name, sdk);
        },
        set:
          descriptor.set || descriptor.writable
            ? (value: unknown) => {
                Reflect.set(sdk, name, value, sdk);
              }
            : undefined
      });
    }
  }

  return publicSdk;
}
