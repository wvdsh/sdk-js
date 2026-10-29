import { IFRAME_MESSAGE_TYPE, type IFrameEventPayloadMap } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { logger, type Logger } from "../utils/logger";
import { type SameOriginFrames } from "../utils/sameOriginFrames";
import { type AudioCaptureTap } from "./audio";
import { WavedashManager } from "./manager";

type RecordingChangedMessage =
  IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.RECORDING_CHANGED];
type RecordingHotkeyChangedMessage =
  IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED];

type RecorderMessageType =
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_STARTED
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_DATA
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_FINISHED
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_FAILED;

export interface RecorderHost {
  version: 1;
  postToParent: <T extends RecorderMessageType>(
    type: T,
    payload: IFrameEventPayloadMap[T],
    transfer?: Transferable[]
  ) => void;
  createAudioTap: () => AudioCaptureTap | null;
  sameOriginFrames: SameOriginFrames;
  logger: Logger;
}

export interface Recorder {
  start: (recordingId: number) => void;
  stop: () => void;
  destroy: () => void;
}

export interface RecorderModule {
  createRecorder: (host: RecorderHost) => Recorder;
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ScreenCaptureManager extends WavedashManager {
  private recorder: Promise<Recorder> | null = null;
  private hotkey: string | null;
  private hotkeyWindows = new Set<Window>();
  private unsubscribeFrames: () => void;

  constructor(
    sdk: WavedashSDK,
    recordingHotkey: string | undefined,
    private readonly loadRecorderModule:
      | (() => Promise<RecorderModule>)
      | undefined
  ) {
    super(sdk);
    this.hotkey = recordingHotkey || null;
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.RECORDING_CHANGED,
      this.handleRecordingChanged
    );
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

  private handleRecordingChanged = (data: RecordingChangedMessage): void => {
    if (!data.isRecording) {
      void this.recorder?.then(
        (recorder) => recorder.stop(),
        () => undefined
      );
      return;
    }
    const recordingId = data.recordingId!;
    this.loadRecorder().then(
      (recorder) => recorder.start(recordingId),
      (error) => {
        logger.error("Screen capture: recorder unavailable", error);
        this.sdk.iframeMessenger.postToParent(
          IFRAME_MESSAGE_TYPE.RECORDING_FAILED,
          { recordingId, error: `Recorder unavailable: ${errorMessage(error)}` }
        );
      }
    );
  };

  private loadRecorder(): Promise<Recorder> {
    if (this.recorder) return this.recorder;
    const load = this.loadRecorderModule;
    if (!load) {
      return Promise.reject(new Error("no recorder in this environment"));
    }
    const host: RecorderHost = {
      version: 1,
      postToParent: (type, payload, transfer) => {
        this.sdk.iframeMessenger.postToParent(type, payload, transfer);
      },
      createAudioTap: () => this.sdk.audioManager.createCaptureTap(),
      sameOriginFrames: this.sdk.sameOriginFrames,
      logger
    };
    const loading = load()
      .then((module) => module.createRecorder(host))
      .catch((error) => {
        if (this.recorder === loading) this.recorder = null;
        throw error;
      });
    this.recorder = loading;
    return loading;
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
      IFRAME_MESSAGE_TYPE.RECORDING_CHANGED,
      this.handleRecordingChanged
    );
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED,
      this.handleHotkeyChanged
    );
    this.unsubscribeFrames();
    this.hotkeyWindows.forEach((win) => this.removeKeyListener(win));
    this.hotkeyWindows.clear();
    void this.recorder?.then(
      (recorder) => recorder.destroy(),
      () => undefined
    );
    super.destroy();
  }
}
