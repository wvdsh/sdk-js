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
   * like MUTE_CHANGED/FULLSCREEN_CHANGED — we start/stop capture to match,
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
  RECORDING_COMPLETE: "RecordingComplete"
} as const;

// The IFrameMessenger is typed against the published IFrameEventPayloadMap,
// which doesn't know about these message types yet (see TODO above).
type IFrameMessageType = Parameters<IFrameMessenger["addEventListener"]>[0];
type IFrameMessageListener = Parameters<IFrameMessenger["addEventListener"]>[1];
type ParentMessageType = Parameters<IFrameMessenger["postToParent"]>[0];

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
const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];

function pickMimeType(): string | null {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  for (const mime of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return null;
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
  private originalGetContext:
    | typeof HTMLCanvasElement.prototype.getContext
    | null = null;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.installCanvasTracking();
    this.sdk.iframeMessenger.addEventListener(
      SCREEN_CAPTURE_MESSAGE_TYPE.RECORDING_CHANGED as IFrameMessageType,
      this.handleRecordingChanged as IFrameMessageListener
    );
  }

  isRecording(): boolean {
    return this.active !== null;
  }

  private handleRecordingChanged = (data: RecordingChangedMessage): void => {
    // State broadcast, not a command — ignore no-op flips (e.g. the parent
    // confirming a stop we initiated ourselves after a capture error).
    if (data.isRecording === this.isRecording()) return;
    if (data.isRecording) {
      this.start(data);
    } else {
      void this.stop();
    }
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
      this.postFailure(
        `canvas.captureStream failed: ${error instanceof Error ? error.message : String(error)}`
      );
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

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND
      });
    } catch (error) {
      for (const track of stream.getTracks()) track.stop();
      audioTap?.dispose();
      this.postFailure(
        `MediaRecorder failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };
    recorder.onerror = (event: Event) => {
      logger.error("Screen capture: recorder error", event);
      void this.stop();
    };

    recorder.start(TIMESLICE_MS);
    this.active = {
      recorder,
      chunks,
      stream,
      mimeType,
      canvas,
      audioTap,
      startedAt: Date.now()
    };
    logger.info(
      `Screen capture: recording started ${canvas.width}x${canvas.height} @ ${fps}fps`,
      mimeType
    );
  }

  private async stop(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = null;

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
   * Largest connected tracked canvas wins — games often allocate small
   * scratch canvases for text measurement or sprite baking, while the main
   * render target dominates the viewport.
   */
  private pickCanvas(): HTMLCanvasElement | null {
    let best: HTMLCanvasElement | null = null;
    let bestArea = 0;
    for (const canvas of this.canvases) {
      if (!canvas.isConnected) continue;
      const area = (canvas.width || 0) * (canvas.height || 0);
      if (area > bestArea) {
        bestArea = area;
        best = canvas;
      }
    }
    // Canvases that got their context before the SDK loaded never hit the
    // getContext shim; fall back to whatever is in the DOM.
    return best ?? document.querySelector("canvas");
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

    // Best-effort: flush an in-flight recording to the parent on teardown.
    void this.stop();

    if (this.originalGetContext) {
      HTMLCanvasElement.prototype.getContext = this.originalGetContext;
      this.originalGetContext = null;
    }
    this.canvases = [];

    super.destroy();
  }
}
