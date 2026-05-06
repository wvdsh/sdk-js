import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { WavedashManager } from "./manager";

/**
 * OverlayManager
 *
 * Owns the iframe ↔ parent interactions for the Wavedash overlay UI:
 * - Shift+Tab inside the iframe toggles the overlay on the host page
 *   (the host owns the overlay, so we postMessage up).
 * - When the parent closes the overlay it sends TAKE_FOCUS so keyboard
 *   input goes back to the game; we walk the DOM for a focusable target.
 * - `takeFocus()` is also called after load completes so the game starts
 *   with keyboard focus without the player clicking first.
 */
export class OverlayManager extends WavedashManager {
  constructor(sdk: WavedashSDK) {
    super(sdk);

    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.TAKE_FOCUS,
      () => this.takeFocus()
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

  takeFocus(): void {
    if (typeof document === "undefined") return;

    const gameFocusTargets =
      document.getElementsByClassName("game-focus-target");
    if (gameFocusTargets.length > 0) {
      (gameFocusTargets[0] as HTMLElement).focus();
      return;
    }

    // Fallback: focus the first focusable element (canvas, input, button, etc.)
    const focusableElement = document.querySelector(
      "canvas, input, button, [tabindex]:not([tabindex='-1'])"
    ) as HTMLElement | null;
    focusableElement?.focus();
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Tab" && event.shiftKey) {
      event.preventDefault();
      this.toggleOverlay();
    }
  };
}
