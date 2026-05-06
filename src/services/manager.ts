import type { WavedashSDK } from "../index";

/**
 * Base class for SDK managers. Provides the shared `sdk` reference and a
 * default no-op `destroy()` so the SDK can safely iterate every manager
 * during teardown without each one having to define an empty stub.
 *
 * Override `destroy()` in any manager that owns ongoing state — Convex
 * subscriptions, intervals, peer connections, monkey-patched globals, etc.
 * — to make sure that state is released when the SDK is torn down.
 */
export abstract class WavedashManager {
  protected sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  destroy(): void {}
}
