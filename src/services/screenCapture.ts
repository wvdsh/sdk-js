import { type WavedashSDK } from "../index";
import type { IFrameMessenger } from "../utils/iframeMessenger";
import { logger } from "../utils/logger";
import { WavedashManager } from "./manager";

/**
 * Iframe message types for gameplay capture.
 * TODO: fold these into IFRAME_MESSAGE_TYPE in @wvdsh/api once the host-side
 * support ships; the casts below go away with it.
 */
export const SCREEN_CAPTURE_MESSAGE_TYPE = {
  /**
   * Parent → SDK: desired recording state, `{ isRecording, fps? }`. Broadcast
   * like VOLUME_CHANGED/FULLSCREEN_CHANGED — we start/stop capture to match,
   * and a broadcast that already matches our state is a no-op.
   */
  RECORDING_CHANGED: "RecordingChanged",
  /**
   * SDK → Parent: recording result. On success carries the recording Blob
   * (`{ success: true, blob, mimeType, width, height, durationMs }`),
   * on failure `{ success: false, error }`. The Blob rides postMessage's
   * structured clone, which hands over a reference to the same immutable
   * backing data — not a byte-by-byte copy — so this is cheap even for a
   * long clip.
   */
  RECORDING_COMPLETE: "RecordingComplete",
  /**
   * Parent → SDK: the recording hotkey to intercept, `{ hotkey }` (null =
   * none). The initial value arrives as SDKConfig.recordingHotkey.
   */
  RECORDING_HOTKEY_CHANGED: "RecordingHotkeyChanged",
  /** SDK → Parent: the player pressed the hotkey while the game had focus. */
  RECORDING_HOTKEY_PRESSED: "RecordingHotkeyPressed"
} as const;

// The IFrameMessenger is typed against the published IFrameEventPayloadMap,
// which doesn't know about these message types yet (see TODO above).
type IFrameMessageType = Parameters<IFrameMessenger["addEventListener"]>[0];
type IFrameMessageListener = Parameters<IFrameMessenger["addEventListener"]>[1];
type ParentMessageType = Parameters<IFrameMessenger["postToParent"]>[0];

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

/**
 * Serialize a keypress the way the host stores hotkeys: held modifiers in a
 * fixed order, then KeyboardEvent.code (e.g. "Alt+Shift+KeyR"). `code` is the
 * physical key, so Option-combos on macOS still match. Null for a bare
 * modifier press.
 */
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

interface RecordingChangedMessage {
  isRecording: boolean;
  fps?: number;
}

interface ActiveRecording {
  recorder: MediaRecorder;
  chunks: Blob[];
  stream: MediaStream;
  mimeType: string | null;
  canvas: HTMLCanvasElement;
  audioTap: { tracks: MediaStreamTrack[]; dispose: () => void } | null;
  startedAt: number;
  /** Set when the recorder errors; stop() then reports failure, not a clip. */
  error: string | null;
}

const DEFAULT_FPS = 60;
/** Ask the recorder to flush a chunk every second so memory stays bounded. */
const TIMESLICE_MS = 1_000;
/** ~13 MB/min — comfortably above what canvas content needs at 1080p60. */
const VIDEO_BITS_PER_SECOND = 14_000_000;

const RENDERING_CONTEXT_TYPES = new Set([
  "2d",
  "webgl",
  "webgl2",
  "webgpu",
  "experimental-webgl"
]);

// Preference order: H.264+AAC in MP4 first — same instant, transcode-free
// pipeline, but the file is shareable everywhere (QuickTime, iOS, X/Twitter,
// iMessage), which VP9 WebM is not. Chrome 126+, Edge, and Safari all mux MP4
// natively in MediaRecorder; Firefox doesn't, so it walks down to WebM.
const MIME_CANDIDATES_WITH_AUDIO = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];
// Audio is best-effort, so the stream may be video-only — and some browsers
// refuse to record a stream that lacks a track a codecs string names.
const MIME_CANDIDATES_VIDEO_ONLY = [
  'video/mp4;codecs="avc1.42E01E"',
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm"
];

function pickMimeType(hasAudio: boolean): string | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  const candidates = hasAudio
    ? MIME_CANDIDATES_WITH_AUDIO
    : MIME_CANDIDATES_VIDEO_ONLY;
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * ScreenCaptureManager
 *
 * Records gameplay clips from inside the iframe — no getDisplayMedia
 * permission prompt, no picker, nothing but the game in frame. The parent
 * drives it over postMessage:
 *
 *   RecordingChanged isRecording:true → grab the game's canvas via
 *   `canvas.captureStream()`, mix in the game's audio through AudioManager's
 *   capture tap, and feed a MediaRecorder. The parent owns recording
 *   duration — the SDK records until RecordingChanged isRecording:false
 *   arrives, then posts the resulting Blob back as RecordingComplete.
 *
 * Canvas discovery mirrors the audio shims' philosophy: wrap
 * `HTMLCanvasElement.prototype.getContext` to see every canvas the game
 * renders to (including offscreen/detached ones at creation time), then pick
 * the largest connected one when recording starts. A DOM query is the
 * fallback for canvases created before the SDK loaded.
 */
export class ScreenCaptureManager extends WavedashManager {
  private canvases: HTMLCanvasElement[] = [];
  private active: ActiveRecording | null = null;
  // The previous recorder's flush, while in flight. A start that arrives
  // meanwhile is parked in pendingStart and runs once the flush finishes, so
  // two recorders never overlap.
  private stopping: Promise<void> | null = null;
  private pendingStart: RecordingChangedMessage | null = null;
  private hotkey: string | null;
  private originalGetContext:
    | typeof HTMLCanvasElement.prototype.getContext
    | null = null;

  constructor(sdk: WavedashSDK, recordingHotkey?: string) {
    super(sdk);
    this.hotkey = recordingHotkey || null;
    this.installCanvasTracking();
    this.sdk.iframeMessenger.addEventListener(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_CHANGED as IFrameMessageType,
      this.handleRecordingChanged as IFrameMessageListener
    );
    this.sdk.iframeMessenger.addEventListener(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED as IFrameMessageType,
      this.handleHotkeyChanged as IFrameMessageListener
    );
    if (typeof window !== "undefined") {
      // Capture phase, so we see it before game handlers registered on window.
      window.addEventListener("keydown", this.handleKeyDown, true);
    }
  }

  isRecording(): boolean {
    return this.active !== null;
  }

  private handleRecordingChanged = (data: RecordingChangedMessage): void => {
    // State broadcast, not a command — ignore no-op flips (e.g. the parent
    // confirming a stop we initiated ourselves after a capture error).
    if (data.isRecording) {
      if (this.active) return;
      if (this.stopping) {
        this.pendingStart = data;
        return;
      }
      this.start(data);
    } else {
      this.pendingStart = null;
      void this.stop();
    }
  };

  private handleHotkeyChanged = (data: { hotkey: string | null }): void => {
    this.hotkey =
      typeof data.hotkey === "string" && data.hotkey ? data.hotkey : null;
  };

  /**
   * Keyboard focus sits in the game frame during play, so the host page can't
   * see its own hotkey — we catch it here and report it. The parent stays the
   * source of truth and toggles recording via RecordingChanged as usual.
   */
  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.hotkey || event.repeat) return;
    if (hotkeyFromEvent(event) !== this.hotkey) return;
    // The hotkey belongs to Wavedash; keep it from the game.
    event.preventDefault();
    event.stopImmediatePropagation();
    this.sdk.iframeMessenger.postToParent(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_HOTKEY_PRESSED as ParentMessageType,
      {}
    );
  };

  private start(options: RecordingChangedMessage): void {
    const canvas = this.pickCanvas();
    if (!canvas) {
      this.postFailure("No game canvas found.");
      return;
    }

    const fps =
      typeof options.fps === "number" && Number.isFinite(options.fps)
        ? Math.min(Math.max(options.fps, 1), 60)
        : DEFAULT_FPS;

    let stream: MediaStream;
    try {
      stream = canvas.captureStream(fps);
    } catch (error) {
      this.postFailure(`canvas.captureStream failed: ${errorMessage(error)}`);
      return;
    }

    // Audio is best-effort — a silent clip beats no clip.
    let audioTap: ActiveRecording["audioTap"] = null;
    try {
      audioTap = this.sdk.audioManager.createCaptureTap();
      if (audioTap) {
        for (const track of audioTap.tracks) stream.addTrack(track);
      }
    } catch (error) {
      logger.warn("Screen capture: audio tap unavailable", error);
      audioTap = null;
    }

    const mimeType = pickMimeType(stream.getAudioTracks().length > 0);
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND
      });
      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      };
      // start() can still reject the stream/encoder pairing after a
      // successful constructor, so it shares the cleanup below.
      recorder.start(TIMESLICE_MS);
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      audioTap?.dispose();
      this.postFailure(`MediaRecorder failed: ${errorMessage(error)}`);
      return;
    }

    const active: ActiveRecording = {
      recorder,
      chunks,
      stream,
      mimeType,
      canvas,
      audioTap,
      startedAt: Date.now(),
      error: null
    };
    recorder.onerror = (event: Event) => {
      logger.error("Screen capture: recorder error", event);
      const error = (event as Event & { error?: unknown }).error;
      active.error = error
        ? `Recorder error: ${errorMessage(error)}`
        : "Recorder error";
      if (this.active === active) void this.stop();
    };
    this.active = active;
    logger.info(
      `Screen capture: recording started ${canvas.width}x${canvas.height} @ ${fps}fps`,
      mimeType
    );
  }

  private stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const active = this.active;
    if (!active) return Promise.resolve();
    this.active = null;
    this.stopping = this.finish(active).finally(() => {
      this.stopping = null;
      const pending = this.pendingStart;
      this.pendingStart = null;
      if (pending) this.start(pending);
    });
    return this.stopping;
  }

  /** Flush a stopped recording and report it to the parent. */
  private async finish(active: ActiveRecording): Promise<void> {
    // Wait for the recorder to flush its final chunk before assembling.
    await new Promise<void>((resolve) => {
      if (active.recorder.state === "inactive") {
        resolve();
        return;
      }
      active.recorder.onstop = () => resolve();
      try {
        active.recorder.stop();
      } catch {
        resolve();
      }
    });

    for (const track of active.stream.getTracks()) track.stop();
    active.audioTap?.dispose();

    if (active.error) {
      this.postFailure(active.error);
      return;
    }

    const blob = new Blob(
      active.chunks,
      active.mimeType ? { type: active.mimeType } : undefined
    );
    const durationMs = Date.now() - active.startedAt;
    logger.info(
      `Screen capture: recording finished, ${blob.size} bytes over ${durationMs}ms`
    );

    this.postToParent({
      success: true,
      blob,
      mimeType: active.mimeType ?? blob.type,
      width: active.canvas.width,
      height: active.canvas.height,
      durationMs
    });
  }

  private postFailure(error: string): void {
    logger.warn(`Screen capture: ${error}`);
    this.postToParent({ success: false, error });
  }

  private postToParent(data: Record<string, unknown>): void {
    this.sdk.iframeMessenger.postToParent(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_COMPLETE as ParentMessageType,
      data
    );
  }

  /**
   * Largest connected canvas wins — games often allocate small scratch
   * canvases for text measurement or sprite baking, while the main render
   * target dominates the viewport. Canvases that got their context before the
   * SDK loaded never hit the getContext shim, so DOM canvases are candidates
   * too.
   */
  private pickCanvas(): HTMLCanvasElement | null {
    const candidates = new Set(this.canvases);
    if (typeof document !== "undefined") {
      document.querySelectorAll("canvas").forEach((c) => candidates.add(c));
    }
    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const canvas of candidates) {
      if (!canvas.isConnected) continue;
      const area = (canvas.width || 0) * (canvas.height || 0);
      if (area > bestArea) {
        bestArea = area;
        best = canvas;
      }
    }
    return best;
  }

  private installCanvasTracking(): void {
    if (typeof HTMLCanvasElement === "undefined") return;
    const original = HTMLCanvasElement.prototype.getContext;
    this.originalGetContext = original;
    ((manager) => {
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        ...args: [string, unknown?]
      ) {
        const ctx = (
          original as (
            this: HTMLCanvasElement,
            ...a: [string, unknown?]
          ) => RenderingContext | null
        ).apply(this, args);
        const type = args[0];
        if (ctx && typeof type === "string") {
          if (
            RENDERING_CONTEXT_TYPES.has(type.toLowerCase()) &&
            !manager.canvases.includes(this)
          ) {
            manager.canvases.push(this);
          }
        }
        return ctx;
      } as typeof HTMLCanvasElement.prototype.getContext;
    })(this);
  }

  override destroy(): void {
    this.sdk.iframeMessenger.removeEventListener(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_CHANGED as IFrameMessageType,
      this.handleRecordingChanged as IFrameMessageListener
    );
    this.sdk.iframeMessenger.removeEventListener(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_HOTKEY_CHANGED as IFrameMessageType,
      this.handleHotkeyChanged as IFrameMessageListener
    );
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.handleKeyDown, true);
    }

    // Best-effort: flush an in-flight recording to the parent on teardown.
    this.pendingStart = null;
    void this.stop();

    if (this.originalGetContext) {
      HTMLCanvasElement.prototype.getContext = this.originalGetContext;
      this.originalGetContext = null;
    }
    this.canvases = [];

    super.destroy();
  }
}
