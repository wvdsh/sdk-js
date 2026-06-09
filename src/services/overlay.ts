import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { takeFocus } from "../utils/focus";
import { suspendPointerLock } from "../utils/pointerLock";
import { WavedashManager } from "./manager";

/**
 * OverlayManager
 *
 * Owns the iframe ↔ parent interactions for the Wavedash overlay UI:
 * - Shift+Tab inside the iframe toggles the overlay on the host page
 *   (the host owns the overlay, so we postMessage up).
 * - When the parent closes the overlay it sends TAKE_FOCUS, which hands
 *   keyboard focus back to the game (see `takeFocus`).
 * - While the overlay is open we suspend pointer lock (the host broadcasts
 *   OVERLAY_CHANGED) so a game can't hold/re-grab the cursor behind it.
 */
export class OverlayManager extends WavedashManager {
  // Restores native pointer lock; set while the overlay is open.
  private restorePointerLock: (() => void) | undefined;

  constructor(sdk: WavedashSDK) {
    super(sdk);

    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.TAKE_FOCUS,
      () => takeFocus()
    );

    /** @TODO uncomment once @wvdsh/api is published with latest IFRAME_MESSAGE_TYPE */
    // this.sdk.iframeMessenger.addEventListener(
    //   IFRAME_MESSAGE_TYPE.OVERLAY_CHANGED,
    //   ({ isOpen }) => this.setOpen(isOpen)
    // );

    if (typeof window !== "undefined") {
      window.addEventListener("keydown", this.handleKeyDown);
    }
  }

  private setOpen(open: boolean): void {
    if (open) {
      this.restorePointerLock ??= suspendPointerLock();
    } else {
      this.restorePointerLock?.();
      this.restorePointerLock = undefined;
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
}
