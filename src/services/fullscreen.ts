import { IFRAME_MESSAGE_TYPE } from "@wvdsh/types";
import type { WavedashSDK } from "../index";

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
interface FullscreenChangedMessage {
  isFullscreen?: boolean;
}

export class FullscreenManager {
  #isFullscreen = false;
  #listeners = new Set<(isFullscreen: boolean) => void>();
  #sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.#sdk = sdk;
    this.#sdk.iframeMessenger.onPush(
      IFRAME_MESSAGE_TYPE.FULLSCREEN_CHANGED,
      (data) => {
        const message = data as FullscreenChangedMessage;
        this.#setState(Boolean(message.isFullscreen));
      }
    );
    this.#installCompatShims();
  }

  isFullscreen(): boolean {
    return this.#isFullscreen;
  }

  /** Ask the host to enter (true) or exit (false) fullscreen. */
  requestFullscreen(fullscreen: boolean): void {
    this.#sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.SET_FULLSCREEN, {
      fullscreen
    });
  }

  toggleFullscreen(): void {
    this.#sdk.iframeMessenger.postToParent(
      IFRAME_MESSAGE_TYPE.TOGGLE_FULLSCREEN,
      {}
    );
  }

  /** Subscribe to state flips. Returns an unsubscribe fn. */
  subscribe(listener: (isFullscreen: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #setState(isFullscreen: boolean): void {
    if (this.#isFullscreen === isFullscreen) return;
    this.#isFullscreen = isFullscreen;
    for (const listener of this.#listeners) listener(isFullscreen);
  }

  #installCompatShims(): void {
    if (typeof document === "undefined") return;

    // Drive reads: many games read `document.fullscreenElement` to figure out
    // whether they're fullscreen. We expose `document.body` when the parent
    // has us fullscreen, so truthy checks keep working.
    const fullscreenElementGetter = () =>
      this.#isFullscreen ? document.body : null;

    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: fullscreenElementGetter
    });
    Object.defineProperty(document, "webkitFullscreenElement", {
      configurable: true,
      get: fullscreenElementGetter
    });

    // Drive writes: requestFullscreen enters, exitFullscreen exits. Both
    // return a Promise to match the native signature; games that `await` them
    // still get sensible behavior (we resolve on the next parent-reported
    // state flip).
    const enter = (): Promise<void> => {
      if (this.#isFullscreen) return Promise.resolve();
      this.requestFullscreen(true);
      return this.#waitForState(true);
    };
    const exit = (): Promise<void> => {
      if (!this.#isFullscreen) return Promise.resolve();
      this.requestFullscreen(false);
      return this.#waitForState(false);
    };

    Element.prototype.requestFullscreen = function () {
      return enter();
    };
    // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
    Element.prototype.webkitRequestFullscreen = function () {
      return enter();
    };

    Document.prototype.exitFullscreen = function () {
      return exit();
    };
    // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
    Document.prototype.webkitExitFullscreen = function () {
      return exit();
    };

    // Fan state changes out as synthetic events so listeners on `document`
    // ("fullscreenchange", "webkitfullscreenchange") fire exactly once per flip.
    this.subscribe(() => {
      document.dispatchEvent(new Event("fullscreenchange"));
      document.dispatchEvent(new Event("webkitfullscreenchange"));
    });
  }

  #waitForState(target: boolean): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.subscribe((isFullscreen) => {
        if (isFullscreen === target) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
}
