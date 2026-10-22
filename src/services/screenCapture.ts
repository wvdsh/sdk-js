import {
  IFRAME_MESSAGE_TYPE,
  type IFrameEventPayloadMap,
  type RecordingCompletePayload,
  type RecordingFailureReason
} from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { logger } from "../utils/logger";
import { WavedashManager } from "./manager";

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

interface FixedSizeCapture {
  stream: MediaStream;
  width: number;
  height: number;
  dispose: () => void;
}

interface ActiveRecording {
  recorder: MediaRecorder;
  chunks: Blob[];
  mimeType: string | null;
  capture: FixedSizeCapture;
  audioTap: { tracks: MediaStreamTrack[]; dispose: () => void } | null;
  startedAt: number;
  /** Set when the recorder errors; stop() then reports failure, not a clip. */
  error: string | null;
  /** From the RecordingChanged that started this; echoed in the result. */
  recordingId: number | undefined;
}

const CAPTURE_FPS = 60;
/** Ask the recorder to flush a chunk every second so memory stays bounded. */
const TIMESLICE_MS = 1_000;
/**
 * Recording resolution cap (long edge): 900p. A smooth 60fps matters more
 * than resolution for gameplay clips, and at 1080p60 the copy + encode can't
 * keep up on typical laptops — every pixel also steals frame time from the
 * game itself.
 */
const MAX_CAPTURE_EDGE = 1600;
/** ~75 MB/min — comfortably above what 900p60 game footage needs. */
const VIDEO_BITS_PER_SECOND = 10_000_000;

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
 *   arrives, then posts the resulting Blob back as RecordingComplete,
 *   echoing the start's `recordingId` so the parent can drop stale results.
 *   The Blob rides postMessage's structured clone, which hands over a
 *   reference to the same immutable backing data — not a byte-by-byte copy —
 *   so this is cheap even for a long clip.
 *
 * The parent also sends the recording hotkey (SDKConfig.recordingHotkey,
 * then RecordingHotkeyChanged); we intercept it while the game has focus and
 * report RecordingHotkeyPressed.
 *
 * The game's canvas is found when recording starts: the largest one in the
 * document (see pickCanvas).
 */
export class ScreenCaptureManager extends WavedashManager {
  private active: ActiveRecording | null = null;
  // The previous recorder's flush, while in flight. A start that arrives
  // meanwhile is parked in pendingStart and runs once the flush finishes, so
  // two recorders never overlap.
  private stopping: Promise<void> | null = null;
  private pendingStart: RecordingChangedMessage | null = null;
  private hotkey: string | null;

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
    if (typeof window !== "undefined") {
      // Capture phase, so we see it before game handlers registered on window.
      window.addEventListener("keydown", this.handleKeyDown, true);
    }
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

  private handleHotkeyChanged = (data: RecordingHotkeyChangedMessage): void => {
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
      IFRAME_MESSAGE_TYPE.RECORDING_HOTKEY_PRESSED,
      {}
    );
  };

  private start(options: RecordingChangedMessage): void {
    const canvas = this.pickCanvas();
    if (!canvas) {
      // DOM-rendered games (or ones whose canvas lives in a frame we can't
      // reach) have nothing for captureStream() to record.
      this.postFailure(
        options.recordingId,
        "No game canvas found.",
        "no-canvas"
      );
      return;
    }

    let capture: FixedSizeCapture;
    try {
      capture = this.createFixedSizeCapture(canvas);
    } catch (error) {
      this.postFailure(
        options.recordingId,
        `canvas.captureStream failed: ${errorMessage(error)}`
      );
      return;
    }
    const stream = capture.stream;

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
      capture.dispose();
      audioTap?.dispose();
      this.postFailure(
        options.recordingId,
        `MediaRecorder failed: ${errorMessage(error)}`
      );
      return;
    }

    const active: ActiveRecording = {
      recorder,
      chunks,
      mimeType,
      capture,
      audioTap,
      startedAt: Date.now(),
      recordingId: options.recordingId,
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
      `Screen capture: recording started ${capture.width}x${capture.height} @ ${CAPTURE_FPS}fps`,
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

    for (const track of active.capture.stream.getTracks()) track.stop();
    active.capture.dispose();
    active.audioTap?.dispose();

    if (active.error) {
      this.postFailure(active.recordingId, active.error);
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
      ...(active.recordingId !== undefined && {
        recordingId: active.recordingId
      }),
      blob,
      mimeType: active.mimeType ?? blob.type,
      width: active.capture.width,
      height: active.capture.height,
      durationMs
    });
  }

  /**
   * `reason` is a machine-readable cause the parent can explain to the player
   * (RecordingFailureReason); `error` is free-form detail.
   */
  private postFailure(
    recordingId: number | undefined,
    error: string,
    reason?: RecordingFailureReason
  ): void {
    logger.warn(`Screen capture: ${error}`);
    this.postToParent({
      success: false,
      error,
      ...(recordingId !== undefined && { recordingId }),
      ...(reason && { reason })
    });
  }

  private postToParent(payload: RecordingCompletePayload): void {
    this.sdk.iframeMessenger.postToParent(
      IFRAME_MESSAGE_TYPE.RECORDING_COMPLETE,
      payload
    );
  }

  /**
   * Re-render a canvas's capture stream onto a fixed-size canvas (sized from
   * the source at start, letterboxed after), so the recording's resolution
   * never changes. Games resize their canvas mid-session — dynamic resolution
   * scaling, window resizes, fullscreen — and MediaRecorder freezes or
   * corrupts the clip when its input resolution changes.
   *
   * The source is read through captureStream() + a <video>, not drawImage on
   * the canvas itself: that's reliable for WebGL canvases without
   * preserveDrawingBuffer, whose buffer may already be cleared when we read.
   */
  private createFixedSizeCapture(source: HTMLCanvasElement): FixedSizeCapture {
    const scale = Math.min(
      1,
      MAX_CAPTURE_EDGE / Math.max(source.width, source.height)
    );
    // Even dimensions: H.264 encoders reject or pad odd sizes.
    const width = Math.max(2, Math.round((source.width * scale) / 2) * 2);
    const height = Math.max(2, Math.round((source.height * scale) / 2) * 2);

    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    const ctx = output.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D context unavailable");

    const sourceStream = source.captureStream(CAPTURE_FPS);
    const video = document.createElement("video");
    this.sdk.audioManager.ignoreMediaElement(video);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = sourceStream;
    video.play().catch(() => {});

    const draw = (): void => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const fit = Math.min(width / vw, height / vh);
      const dw = vw * fit;
      const dh = vh * fit;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
    };

    // Copy once per new game frame where supported, so the clip neither
    // repeats nor skips frames the way an unsynced rAF loop does; rAF
    // elsewhere (older Firefox).
    let cancelDraws: () => void;
    if (typeof video.requestVideoFrameCallback === "function") {
      let handle = 0;
      const onFrame = (): void => {
        draw();
        handle = video.requestVideoFrameCallback(onFrame);
      };
      handle = video.requestVideoFrameCallback(onFrame);
      cancelDraws = () => video.cancelVideoFrameCallback(handle);
    } else {
      let handle = 0;
      const onFrame = (): void => {
        draw();
        handle = requestAnimationFrame(onFrame);
      };
      handle = requestAnimationFrame(onFrame);
      cancelDraws = () => cancelAnimationFrame(handle);
    }

    return {
      stream: output.captureStream(CAPTURE_FPS),
      width,
      height,
      dispose: () => {
        cancelDraws();
        video.pause();
        video.srcObject = null;
        for (const track of sourceStream.getTracks()) track.stop();
      }
    };
  }

  /**
   * Largest canvas in the document wins — games often allocate small scratch
   * canvases for text measurement or sprite baking, while the main render
   * target dominates the viewport. Detached canvases aren't on screen, so
   * they're never candidates (nor are ones inside shadow roots).
   */
  private pickCanvas(): HTMLCanvasElement | null {
    if (typeof document === "undefined") return null;
    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    document.querySelectorAll("canvas").forEach((canvas) => {
      const area = (canvas.width || 0) * (canvas.height || 0);
      if (area > bestArea) {
        bestArea = area;
        best = canvas;
      }
    });
    return best;
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
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", this.handleKeyDown, true);
    }

    // Best-effort: flush an in-flight recording to the parent on teardown.
    this.pendingStart = null;
    void this.stop();

    super.destroy();
  }
}
