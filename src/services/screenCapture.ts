import { IFRAME_MESSAGE_TYPE, type IFrameEventPayloadMap } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { logger } from "../utils/logger";
import { type FrameWindow } from "../utils/sameOriginFrames";
import { WavedashManager } from "./manager";
import { RafTail } from "./recording/rafTail";
import type * as RecorderModule from "./recording/recorder";
import recorderSource from "./recording/recorder.ts?module-source";
import { RecordingSession } from "./recording/session";

type ActiveRecording = RecorderModule.ActiveRecording;

let recorderModule: Promise<typeof RecorderModule> | null = null;

function loadRecorder(): Promise<typeof RecorderModule> {
  if (!recorderModule) {
    const url = URL.createObjectURL(
      new Blob([recorderSource], { type: "text/javascript" })
    );
    const loading = (
      import(/* @vite-ignore */ url) as Promise<typeof RecorderModule>
    )
      .catch((error) => {
        if (recorderModule === loading) recorderModule = null;
        throw new Error(
          `Recorder module could not load from a blob: URL (is blob: allowed by the page's Content-Security-Policy script-src?): ${errorMessage(error)}`
        );
      })
      .finally(() => URL.revokeObjectURL(url));
    recorderModule = loading;
  }
  return recorderModule;
}

type RecordingChangedMessage =
  IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.RECORDING_CHANGED];
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CurrentRecording {
  session: RecordingSession;
  recorder: Promise<ActiveRecording | null>;
}

export class ScreenCaptureManager extends WavedashManager {
  private current: CurrentRecording | null = null;
  private finishing: CurrentRecording | null = null;
  private stopping: Promise<void> | null = null;
  private pendingStart: RecordingChangedMessage | null = null;
  private hotkey: string | null;
  private hotkeyWindows = new Set<Window>();
  private frameWindows = new Set<FrameWindow>();
  private rafTail = new RafTail();
  private unsubscribeFrames: () => void;

  constructor(sdk: WavedashSDK, recordingHotkey?: string) {
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
    this.unsubscribeFrames = this.sdk.sameOriginFrames.subscribe({
      attach: (win) => {
        win.addEventListener("keydown", this.handleKeyDown, true);
        this.hotkeyWindows.add(win);
        this.frameWindows.add(win);
        this.rafTail.attach(win);
      },
      detach: (win) => {
        this.hotkeyWindows.delete(win);
        this.frameWindows.delete(win);
        this.rafTail.detach(win);
        this.removeKeyListener(win);
      }
    });
  }

  private handleRecordingChanged = (data: RecordingChangedMessage): void => {
    if (data.isRecording) {
      if (this.current) return;
      if (this.stopping) {
        this.pendingStart = data;
        return;
      }
      this.start(data.recordingId!);
    } else {
      this.pendingStart = null;
      void this.stop();
    }
  };

  private handleHotkeyChanged = (data: RecordingHotkeyChangedMessage): void => {
    this.hotkey =
      typeof data.hotkey === "string" && data.hotkey ? data.hotkey : null;
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.hotkey || event.repeat) return;
    if (hotkeyFromEvent(event) !== this.hotkey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.sdk.iframeMessenger.postToParent(
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_PRESSED,
      {}
    );
  };

  private start(recordingId: number): void {
    const session = new RecordingSession(
      recordingId,
      (type, payload, transfer) =>
        this.sdk.iframeMessenger.postToParent(type, payload, transfer)
    );
    const recorder = loadRecorder()
      .then(({ startRecording }) =>
        startRecording({
          session,
          windows: Array.from(this.frameWindows),
          top: window as FrameWindow,
          rafTail: this.rafTail,
          createAudioTap: () => this.sdk.audioManager.createCaptureTap()
        })
      )
      .catch((error) => {
        logger.error("Screen capture: recorder failed to load", error);
        session.failed(`Recorder failed to load: ${errorMessage(error)}`);
        return null;
      });
    this.current = { session, recorder };
    void recorder.then((active) => {
      if (!active && this.current?.session === session) this.current = null;
    });
  }

  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const current = this.current;
    if (!current) return Promise.resolve();
    this.current = null;
    this.finishing = current;
    this.stopping = this.finish(current).finally(() => {
      this.stopping = null;
      this.finishing = null;
      const pending = this.pendingStart;
      this.pendingStart = null;
      if (pending) this.start(pending.recordingId!);
    });
    return this.stopping;
  }

  private async finish(current: CurrentRecording): Promise<void> {
    const recorder = await current.recorder;
    if (!recorder || !current.session.isOpen) return;
    try {
      await recorder.stop();
    } catch (error) {
      logger.error("Screen capture: recording failed while stopping", error);
      recorder.abort(`Recording failed while stopping: ${errorMessage(error)}`);
    }
  }

  private removeKeyListener(win: Window): void {
    try {
      win.removeEventListener("keydown", this.handleKeyDown, true);
    } catch {
      return;
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
    this.pendingStart = null;
    const error = "Recording interrupted: the game session ended";
    for (const recording of [this.current, this.finishing]) {
      if (!recording) continue;
      recording.session.failed(error);
      void recording.recorder.then((recorder) => recorder?.abort(error));
    }
    this.current = null;
    this.finishing = null;
    this.rafTail.destroy();
    this.frameWindows.clear();
    super.destroy();
  }
}
