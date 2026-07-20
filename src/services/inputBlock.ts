import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { suspendFocusStealing } from "../utils/focusGuard";
import { hasParentFrame } from "../utils/parentOrigin";
import { suspendPointerLock } from "../utils/pointerLock";
import { WavedashManager } from "./manager";

/**
 * InputBlockManager
 *
 * The host page broadcasts INPUT_BLOCKED_CHANGED while the player is engaged
 * with host UI instead of the game — a paywall or search palette is up, they
 * are typing in a comment box, or the frame is scrolled out of view. While
 * blocked, the game may not steal focus (which would grab keystrokes and
 * scroll the host page to the frame) or grab the pointer, so both are
 * suspended via their native-API shims. The host hands focus back explicitly
 * with TAKE_FOCUS once the block clears.
 */
export class InputBlockManager extends WavedashManager {
  // Restore fns for the native APIs; set while input is blocked.
  private restoreFocus: (() => void) | undefined;
  private restorePointerLock: (() => void) | undefined;

  constructor(sdk: WavedashSDK) {
    super(sdk);

    // Standalone (no host page) — nothing can block input.
    if (!hasParentFrame()) return;

    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.INPUT_BLOCKED_CHANGED,
      ({ isBlocked }) => this.setBlocked(isBlocked)
    );
  }

  private setBlocked(blocked: boolean): void {
    if (blocked) {
      this.restoreFocus ??= suspendFocusStealing();
      this.restorePointerLock ??= suspendPointerLock();
    } else {
      this.restoreFocus?.();
      this.restoreFocus = undefined;
      this.restorePointerLock?.();
      this.restorePointerLock = undefined;
    }
  }

  destroy(): void {
    this.setBlocked(false);
  }
}
