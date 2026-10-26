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
  // Set when the recorder errors; stop() then reports failure, not a clip
  error: string | null;
  // From the RecordingChanged that started this; echoed in the result
  recordingId: number | undefined;
}

const CAPTURE_FPS = 60;
// Ask the recorder to flush a chunk every second so memory stays bounded
const TIMESLICE_MS = 1_000;
// Long-edge cap (900p): 1080p60 copy + encode can't keep up on typical laptops
const MAX_CAPTURE_EDGE = 1600;
// ~75 MB/min — comfortably above what 900p60 game footage needs
const VIDEO_BITS_PER_SECOND = 10_000_000;

// MP4 first since it's shareable everywhere; Firefox can't mux MP4 so it falls back to WebM
const MIME_CANDIDATES_WITH_AUDIO = [
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];
// Some browsers refuse a stream missing a track its codecs string names
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

function isElementHidden(element: Element): boolean {
  const win = element.ownerDocument.defaultView!;
  if (element.getClientRects().length === 0) return true;
  if (win.getComputedStyle(element).visibility !== "visible") return true;
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (win.getComputedStyle(current).opacity === "0") return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Records the game canvas + audio while the parent's RecordingChanged says so, posting the Blob back as RecordingComplete
export class ScreenCaptureManager extends WavedashManager {
  private active: ActiveRecording | null = null;
  // In-flight flush; a start arriving meanwhile waits in pendingStart so recorders never overlap
  private stopping: Promise<void> | null = null;
  private pendingStart: RecordingChangedMessage | null = null;
  private hotkey: string | null;
  private hotkeyWindows = new Set<Window>();
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
    // Every same-origin frame, since keys pressed in a nested game frame never reach ours
    this.unsubscribeFrames = this.sdk.sameOriginFrames.subscribe({
      attach: (win) => {
        win.addEventListener("keydown", this.handleKeyDown, true);
        this.hotkeyWindows.add(win);
      },
      detach: (win) => {
        win.removeEventListener("keydown", this.handleKeyDown, true);
        this.hotkeyWindows.delete(win);
      }
    });
  }

  private handleRecordingChanged = (data: RecordingChangedMessage): void => {
    // State broadcast, not a command: ignore no-op flips
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

  private start(options: RecordingChangedMessage): void {
    const canvas = this.pickCanvas();
    if (!canvas) {
      // DOM-rendered games, or canvases in frames we can't reach
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
      // start() can still reject the stream/encoder pairing, so it shares the cleanup below
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

  // Flush a stopped recording and report it to the parent
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

  // `reason` is machine-readable for the player-facing message; `error` is free-form detail
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

  // Letterboxes the source into a fixed-size canvas, since MediaRecorder breaks if its input resolution changes
  private createFixedSizeCapture(source: HTMLCanvasElement): FixedSizeCapture {
    // Sized from the on-screen size, since engines like Unity keep the default 300x150 backing store until after load
    const rect = source.getBoundingClientRect();
    const dpr = source.ownerDocument.defaultView!.devicePixelRatio;
    const sourceWidth = rect.width ? rect.width * dpr : source.width;
    const sourceHeight = rect.height ? rect.height * dpr : source.height;
    const scale = Math.min(
      1,
      MAX_CAPTURE_EDGE / Math.max(sourceWidth, sourceHeight)
    );
    // Even dimensions: H.264 encoders reject or pad odd sizes.
    const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
    const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);

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

    // Copy once per game frame where supported; rAF fallback for older Firefox
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

  // Most visible on-screen area wins, then backing-store size; ties go to the earliest (beneath overlays)
  private pickCanvas(): HTMLCanvasElement | null {
    if (typeof document === "undefined") return null;
    let best: HTMLCanvasElement | null = null;
    let bestScore = [-1, -1];
    const visit = (doc: Document, frameHidden: boolean): void => {
      const win = doc.defaultView!;
      doc.querySelectorAll("canvas").forEach((canvas) => {
        const rect = canvas.getBoundingClientRect();
        const visibleWidth = Math.max(
          0,
          Math.min(rect.right, win.innerWidth) - Math.max(rect.left, 0)
        );
        const visibleHeight = Math.max(
          0,
          Math.min(rect.bottom, win.innerHeight) - Math.max(rect.top, 0)
        );
        const score = [
          frameHidden || isElementHidden(canvas)
            ? 0
            : visibleWidth * visibleHeight,
          canvas.width * canvas.height
        ];
        if (
          score[0] > bestScore[0] ||
          (score[0] === bestScore[0] && score[1] > bestScore[1])
        ) {
          bestScore = score;
          best = canvas;
        }
      });
      // Same-origin child frames only; contentDocument is null cross-origin
      doc.querySelectorAll("iframe").forEach((iframe) => {
        if (iframe.contentDocument) {
          visit(iframe.contentDocument, frameHidden || isElementHidden(iframe));
        }
      });
    };
    visit(document, false);
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
    this.unsubscribeFrames();
    this.hotkeyWindows.forEach((win) =>
      win.removeEventListener("keydown", this.handleKeyDown, true)
    );
    this.hotkeyWindows.clear();

    // Best-effort: flush an in-flight recording to the parent on teardown.
    this.pendingStart = null;
    void this.stop();

    super.destroy();
  }
}
