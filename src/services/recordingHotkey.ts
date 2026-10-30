import { IFRAME_MESSAGE_TYPE, type IFrameEventPayloadMap } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { WavedashManager } from "./manager";

type RecordingHotkeyChangedMessage =
  IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED];

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn"
]);

// Host hotkey format: modifiers in fixed order + KeyboardEvent.code (e.g. "Alt+Shift+KeyR"); null for a bare modifier
function hotkeyFromEvent(event: KeyboardEvent): string | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Meta");
  parts.push(event.code);
  return parts.join("+");
}

export class RecordingHotkeyManager extends WavedashManager {
  private hotkey: string | null;
  private hotkeyWindows = new Set<Window>();
  private unsubscribeFrames: () => void;

  constructor(sdk: WavedashSDK, recordingHotkey: string | undefined) {
    super(sdk);
    this.hotkey = recordingHotkey || null;
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED,
      this.handleHotkeyChanged
    );
    // Every same-origin frame, since keys pressed in a nested game frame never reach ours
    this.unsubscribeFrames = this.sdk.sameOriginFrames.subscribe({
      attach: (win) => {
        win.addEventListener("keydown", this.handleKeyDown, true);
        this.hotkeyWindows.add(win);
      },
      detach: (win) => {
        this.hotkeyWindows.delete(win);
        this.removeKeyListener(win);
      }
    });
  }

  private handleHotkeyChanged = (data: RecordingHotkeyChangedMessage): void => {
    this.hotkey =
      typeof data.hotkey === "string" && data.hotkey ? data.hotkey : null;
  };

  // The host page can't see keys while the game has focus, so we catch the hotkey and report it
  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.hotkey || event.repeat) return;
    if (hotkeyFromEvent(event) !== this.hotkey) return;
    // The hotkey belongs to Wavedash; keep it from the game.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.sdk.iframeMessenger.postToParent(
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_PRESSED,
      {}
    );
  };

  private removeKeyListener(win: Window): void {
    try {
      win.removeEventListener("keydown", this.handleKeyDown, true);
    } catch {
      // Navigated cross-origin: the old document, and its listener, are already gone
    }
  }

  override destroy(): void {
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED,
      this.handleHotkeyChanged
    );
    this.unsubscribeFrames();
    this.hotkeyWindows.forEach((win) => this.removeKeyListener(win));
    this.hotkeyWindows.clear();
    super.destroy();
  }
}
