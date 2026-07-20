import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { takeFocus } from "../utils/focus";
import { hasParentFrame } from "../utils/parentOrigin";
import { WavedashManager } from "./manager";

/**
 * OverlayManager
 *
 * Owns the iframe ↔ parent interactions for the Wavedash overlay UI:
 * - Shift+Tab inside the iframe toggles the overlay on the host page
 *   (the host owns the overlay, so we postMessage up).
 * - When the parent closes the overlay it sends TAKE_FOCUS, which hands
 *   keyboard focus back to the game (see `takeFocus`).
 *
 * While the overlay is open the host also broadcasts INPUT_BLOCKED_CHANGED,
 * which suspends pointer lock and focus stealing (see InputBlockManager) —
 * so a game can't hold/re-grab the cursor or focus behind the overlay.
 */
export class OverlayManager extends WavedashManager {
  constructor(sdk: WavedashSDK) {
    super(sdk);

    // No host owns an overlay in standalone — skip the listeners and the
    // Shift+Tab hijack so native tab behavior stays intact.
    if (!hasParentFrame()) return;

    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.TAKE_FOCUS,
      takeFocus
    );

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.handleKeyDown);
    }
  }

  toggleOverlay(): void {
    this.sdk.iframeMessenger.postToParent(
      IFRAME_MESSAGE_TYPE.TOGGLE_OVERLAY,
      {}
    );
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      this.toggleOverlay();
    }
  };

  destroy(): void {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.handleKeyDown);
    }
  }
}
