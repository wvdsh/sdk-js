import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashEvents, type WavedashSDK } from "../index";

/**
 * FullscreenManager
 *
 * Wavedash owns the fullscreen target (a wrapper DIV on the host page that
 * contains both the game iframe and our overlay UI). The SDK inside the iframe
 * therefore can't call `requestFullscreen` directly — it asks the parent to
 * do it via postMessage, and the parent broadcasts state changes back through
 * FULLSCREEN_CHANGED so we can keep a local mirror of `isFullscreen`.
 *
 * User activation: browsers require a fresh user gesture to enter fullscreen.
 * The click happens in the iframe, User Activation v2 propagates transient
 * activation to ancestor frames, and the parent's message handler runs within
 * the ~5s window — so the parent's requestFullscreen call stays activated.
 *
 * Legacy compat: games that call `element.requestFullscreen()` or listen for
 * `fullscreenchange` directly are monkey-patched in the constructor so those
 * calls route through us. The iframe isn't granted the fullscreen feature
 * policy anymore, so without these shims those calls would silently reject.
 */
export class FullscreenManager {
  private _isFullscreen = false;
  private listeners = new Set<(isFullscreen: boolean) => void>();
  private sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.FULLSCREEN_CHANGED,
      (data) => {
        console.log(
          "[wvdsh-sdk] FULLSCREEN_CHANGED received:",
          data.isFullscreen
        );
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.FULLSCREEN_CHANGED,
          data.isFullscreen
        );
        this.setState(data.isFullscreen);
      }
    );
    this.installCompatShims();
  }

  isFullscreen(): boolean {
    return this._isFullscreen;
  }

  /**
   * Ask the host to enter (true) or exit (false) fullscreen. Resolves to
   * `true` if the host reports the operation succeeded, `false` otherwise
   * (e.g. browser rejected for lack of user activation).
   */
  async requestFullscreen(fullscreen: boolean): Promise<boolean> {
    console.log("[wvdsh-sdk] requestFullscreen ->", fullscreen);
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.SET_FULLSCREEN,
      { fullscreen }
    );
    console.log("[wvdsh-sdk] requestFullscreen result:", response.success);
    return response.success;
  }

  async toggleFullscreen(): Promise<boolean> {
    console.log("[wvdsh-sdk] toggleFullscreen");
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.TOGGLE_FULLSCREEN
    );
    console.log("[wvdsh-sdk] toggleFullscreen result:", response.success);
    return response.success;
  }

  /** Subscribe to state flips. Returns an unsubscribe fn. */
  subscribe(listener: (isFullscreen: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(isFullscreen: boolean): void {
    if (this._isFullscreen === isFullscreen) return;
    this._isFullscreen = isFullscreen;
    for (const listener of this.listeners) listener(isFullscreen);
  }

  private installCompatShims(): void {
    if (typeof document === "undefined") return;

    // Drive reads: many games read `document.fullscreenElement` to figure out
    // whether they're fullscreen. We expose `document.body` when the parent
    // has us fullscreen, so truthy checks keep working.
    const fullscreenElementGetter = () =>
      this._isFullscreen ? document.body : null;

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: fullscreenElementGetter
    });
    Object.defineProperty(document, "webkitFullscreenElement", {
      configurable: true,
      get: fullscreenElementGetter
    });

    // Drive writes: requestFullscreen enters, exitFullscreen exits. Both
    // return a Promise to match the native signature — we reject when the
    // host reports the operation failed, matching how the native API
    // rejects on e.g. missing user activation.
    const enter = async (): Promise<void> => {
      if (this._isFullscreen) return;
      const ok = await this.requestFullscreen(true);
      if (!ok) throw new Error("Fullscreen request was denied");
    };
    const exit = async (): Promise<void> => {
      if (!this._isFullscreen) return;
      const ok = await this.requestFullscreen(false);
      if (!ok) throw new Error("Exit fullscreen request was denied");
    };

    Element.prototype.requestFullscreen = function () {
      console.log("[wvdsh-sdk] shim: Element.requestFullscreen called");
      return enter();
    };
    // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
    Element.prototype.webkitRequestFullscreen = function () {
      console.log("[wvdsh-sdk] shim: Element.webkitRequestFullscreen called");
      return enter();
    };

    Document.prototype.exitFullscreen = function () {
      console.log("[wvdsh-sdk] shim: Document.exitFullscreen called");
      return exit();
    };
    // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
    Document.prototype.webkitExitFullscreen = function () {
      console.log("[wvdsh-sdk] shim: Document.webkitExitFullscreen called");
      return exit();
    };

    // Fan state changes out as a bubbling synthetic event so listeners on
    // `document` or `window` fire exactly once per flip, matching native.
    this.subscribe((isFullscreen) => {
      console.log(
        "[wvdsh-sdk] dispatching synthetic fullscreenchange, isFullscreen=",
        isFullscreen
      );
      document.dispatchEvent(new Event("fullscreenchange", { bubbles: true }));
    });
  }
}
