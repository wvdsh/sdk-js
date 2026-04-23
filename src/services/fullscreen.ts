import { IFRAME_MESSAGE_TYPE } from "@wvdsh/types";
import { IFrameMessenger } from "../utils/iframeMessenger";

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
 */
export class FullscreenManager {
  #isFullscreen = false;
  #listeners = new Set<(isFullscreen: boolean) => void>();
  #messenger: IFrameMessenger;

  constructor(messenger: IFrameMessenger) {
    this.#messenger = messenger;
  }

  isFullscreen(): boolean {
    return this.#isFullscreen;
  }

  /** Ask the host to enter (true) or exit (false) fullscreen. */
  requestFullscreen(fullscreen: boolean): void {
    this.#messenger.postToParent(IFRAME_MESSAGE_TYPE.SET_FULLSCREEN, {
      fullscreen
    });
  }

  toggleFullscreen(): void {
    this.#messenger.postToParent(IFRAME_MESSAGE_TYPE.TOGGLE_FULLSCREEN, {});
  }

  /** Invoked by IFrameMessenger when the parent sends FULLSCREEN_CHANGED. */
  onFullscreenChanged(isFullscreen: boolean): void {
    if (this.#isFullscreen === isFullscreen) return;
    this.#isFullscreen = isFullscreen;
    for (const listener of this.#listeners) listener(isFullscreen);
  }

  /** Subscribe to state flips. Returns an unsubscribe fn. */
  subscribe(listener: (isFullscreen: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
