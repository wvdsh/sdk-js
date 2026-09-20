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
  const methods = new Map<
    PropertyKey,
    { original: unknown; wrapped: (...args: unknown[]) => unknown }
  >();

  return new Proxy(sdk, {
    get(target, property) {
      const descriptor = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(target),
        property
      );
      const tracked =
        typeof property === "string" &&
        property !== "constructor" &&
        !property.startsWith("_") &&
        descriptor !== undefined;

      if (tracked && descriptor.get) trackSdkCall(target, property);
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;

      const cached = methods.get(property);
      if (cached && cached.original === value) return cached.wrapped;

      const wrapped = (...args: unknown[]) => {
        if (tracked && typeof descriptor.value === "function")
          trackSdkCall(target, property);
        return Reflect.apply(value, target, args);
      };
      methods.set(property, { original: value, wrapped });
      return wrapped;
    }
  });
}
