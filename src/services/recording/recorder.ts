import type { RecordingFailureReason } from "@wvdsh/api";
import { EventType, record, type eventWithTime } from "rrweb";
import { logger } from "../../utils/logger";
import type { FrameWindow } from "../../utils/sameOriginFrames";
import type { AudioCaptureTap } from "../audio";
import { bitrateFor, fitToEncodeBox } from "./codec";
import { GzipJsonArrayWriter } from "./eventLog";
import {
  buildManifest,
  type AnimationSample,
  type CapturedTrack
} from "./manifest";
import { PartChunker } from "./parts";
import type { RafTail } from "./rafTail";
import type { RecordingSession } from "./session";
import {
  detectHasDom,
  findCaptureCanvases,
  isTransferredCanvas,
  WAVEDASH_UI_BLOCK_SELECTOR,
  type CaptureCanvas
} from "./surface";
import workerSource from "./worker.ts?worker-source";
import {
  AUDIO_WORKLET_NAME,
  AUDIO_WORKLET_SOURCE,
  type FromWorker,
  type MediaStreamTrackProcessorConstructor,
  type ToWorker
} from "./workerProtocol";

const REQUEST_FRAME_FPS = 60;
const MEDIA_RECORDER_FPS = 30;
const MEDIA_RECORDER_TIMESLICE_MS = 1000;
const POSTER_WIDTH = 640;
const POSTER_TAIL_TIMEOUT_MS = 250;
export const TAIL_WATCHDOG_MS = 500;
export const FIRST_FRAME_DEADLINE_MS = 1500;
const WATCHDOG_INTERVAL_MS = 100;

type CaptureMode = "stream" | "track" | "media-recorder";

export interface RecorderHost {
  session: RecordingSession;
  windows: FrameWindow[];
  top: FrameWindow;
  rafTail: RafTail;
  createAudioTap: () => AudioCaptureTap | null;
}

export interface ActiveRecording {
  stop: () => Promise<void>;
  abort: (error: string, reason?: RecordingFailureReason) => void;
}

interface TrackResult {
  remainder: ArrayBuffer;
  firstFrameEpochMs: number;
}

interface TrackCapture {
  index: number;
  canvas: HTMLCanvasElement;
  win: FrameWindow;
  width: number;
  height: number;
  requestFrame: (() => void) | null;
  hasFirstFrame: () => boolean;
  finish: () => Promise<TrackResult>;
  dispose: () => void;
}

interface Pacing {
  lastTailGrabMs: number;
  timer: ReturnType<typeof setInterval> | null;
  warnedDetached: boolean;
}

const epochNow = (): number => performance.timeOrigin + performance.now();
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function blobUrl(source: string): string {
  return URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
}

class WorkerChannel {
  readonly worker: Worker;
  firstFrame = false;
  private handlers = new Set<(message: FromWorker) => void>();

  constructor(
    url: string,
    onPart: (data: ArrayBuffer) => void,
    onError: (message: string) => void
  ) {
    try {
      this.worker = new Worker(url);
    } catch (error) {
      throw new Error(
        `Could not start the recording worker from a blob: URL (is blob: allowed by the page's Content-Security-Policy worker-src?): ${errorText(error)}`
      );
    }
    this.worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
      if (data.type === "part") onPart(data.data);
      else if (data.type === "error") onError(data.message);
      else if (data.type === "first-frame") this.firstFrame = true;
      else if (data.type === "warn") logger.warn(`Recording: ${data.message}`);
      this.handlers.forEach((handler) => handler(data));
    };
    this.worker.onerror = (event) => onError(event.message);
  }

  send(message: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  next<T extends FromWorker["type"]>(
    type: T
  ): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      const handler = (message: FromWorker): void => {
        if (message.type === type) {
          this.handlers.delete(handler);
          resolve(message as Extract<FromWorker, { type: T }>);
        } else if (message.type === "error") {
          this.handlers.delete(handler);
          reject(new Error(message.message));
        }
      };
      this.handlers.add(handler);
    });
  }
}

function canRequestFrame(top: FrameWindow): boolean {
  return (
    typeof top.VideoEncoder !== "undefined" &&
    typeof top.CanvasCaptureMediaStreamTrack !== "undefined" &&
    "requestFrame" in top.CanvasCaptureMediaStreamTrack.prototype
  );
}

function windowProcessor(
  top: FrameWindow
): MediaStreamTrackProcessorConstructor | undefined {
  return (
    top as unknown as {
      MediaStreamTrackProcessor?: MediaStreamTrackProcessorConstructor;
    }
  ).MediaStreamTrackProcessor;
}

function captureCanvasStream(
  canvas: HTMLCanvasElement,
  fps: number
): MediaStream {
  try {
    return canvas.captureStream(fps);
  } catch (error) {
    throw new Error(
      `Cannot capture canvas #${canvas.id || "(no id)"} in this browser (an OffscreenCanvas transferred to a worker is not capturable in Firefox): ${errorText(error)}`
    );
  }
}

async function connectAudio(
  tap: AudioCaptureTap,
  channel: WorkerChannel
): Promise<() => void> {
  const url = blobUrl(AUDIO_WORKLET_SOURCE);
  try {
    await tap.context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const node = new AudioWorkletNode(tap.context, AUDIO_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers"
  });
  const sink = tap.context.createGain();
  sink.gain.value = 0;
  tap.output.connect(node);
  node.connect(sink);
  sink.connect(tap.context.destination);
  channel.send({ type: "audio", port: node.port }, [node.port]);
  return () => {
    tap.output.disconnect(node);
    node.disconnect();
    sink.disconnect();
  };
}

async function openWorkerTrack(
  index: number,
  target: CaptureCanvas,
  mode: "stream" | "track",
  channel: WorkerChannel,
  tap: AudioCaptureTap | null,
  flipY: boolean
): Promise<TrackCapture> {
  let mediaTrack: CanvasCaptureMediaStreamTrack | null = null;
  let disconnectAudio: (() => void) | null = null;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    disconnectAudio?.();
    mediaTrack?.stop();
    channel.worker.terminate();
  };
  try {
    channel.send({
      type: "init",
      sourceWidth: target.canvas.width,
      sourceHeight: target.canvas.height,
      fps: REQUEST_FRAME_FPS,
      audioSampleRate: tap ? tap.context.sampleRate : null,
      flipY
    });
    const ready = await channel.next("ready");
    const track = captureCanvasStream(
      target.canvas,
      0
    ).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    mediaTrack = track;
    if (mode === "stream") {
      const Processor = windowProcessor(target.win)!;
      const readable = new Processor({ track }).readable;
      channel.send({ type: "readable", readable }, [readable]);
    } else {
      const workerTrack = track.clone();
      channel.send({ type: "track", track: workerTrack }, [workerTrack]);
    }
    if (tap && ready.audio) disconnectAudio = await connectAudio(tap, channel);
    if (tap && !ready.audio) {
      logger.warn("Recording: AAC encoding unavailable, recording video only");
    }
    return {
      index,
      canvas: target.canvas,
      win: target.win,
      width: ready.width,
      height: ready.height,
      requestFrame: () => track.requestFrame(),
      hasFirstFrame: () => channel.firstFrame,
      finish: async () => {
        const done = channel.next("done");
        channel.send({ type: "stop" });
        try {
          return await done;
        } finally {
          release();
        }
      },
      dispose: release
    };
  } catch (error) {
    release();
    throw error;
  }
}

function openMediaRecorderTrack(
  index: number,
  target: CaptureCanvas,
  tap: AudioCaptureTap | null,
  onPart: (data: ArrayBuffer) => void,
  onError: (message: string) => void
): TrackCapture {
  const stream = captureCanvasStream(target.canvas, MEDIA_RECORDER_FPS);
  tap?.tracks.forEach((track) => stream.addTrack(track));
  const mimeType = tap ? "video/webm;codecs=vp8,opus" : "video/webm;codecs=vp8";
  const release = (): void => {
    stream.getVideoTracks().forEach((track) => track.stop());
  };
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    release();
    throw new Error(`MediaRecorder does not support ${mimeType}`);
  }
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: bitrateFor(target.canvas.width, target.canvas.height)
  });
  const chunker = new PartChunker(onPart);
  let writes = Promise.resolve();
  let firstFrameEpochMs: number | null = null;
  recorder.onstart = () => {
    firstFrameEpochMs = epochNow();
  };
  recorder.ondataavailable = (event) => {
    const blob = event.data;
    writes = writes.then(async () =>
      chunker.write(new Uint8Array(await blob.arrayBuffer()))
    );
  };
  recorder.onerror = (event) =>
    onError(
      `MediaRecorder error: ${errorText((event as Event & { error?: unknown }).error)}`
    );
  recorder.start(MEDIA_RECORDER_TIMESLICE_MS);
  return {
    index,
    canvas: target.canvas,
    win: target.win,
    width: target.canvas.width,
    height: target.canvas.height,
    requestFrame: null,
    hasFirstFrame: () => true,
    finish: async () => {
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.stop();
      await stopped;
      await writes;
      release();
      if (firstFrameEpochMs === null) {
        throw new Error("MediaRecorder never started");
      }
      return { remainder: chunker.finish(), firstFrameEpochMs };
    },
    dispose: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    }
  };
}

function animationKind(
  animation: Animation,
  win: FrameWindow
): AnimationSample["kind"] {
  if (animation instanceof win.CSSAnimation) return "css-animation";
  if (animation instanceof win.CSSTransition) return "css-transition";
  return "web-animation";
}

function animationName(animation: Animation, win: FrameWindow): string {
  if (animation instanceof win.CSSAnimation) return animation.animationName;
  if (animation instanceof win.CSSTransition) {
    return animation.transitionProperty;
  }
  return animation.id;
}

function sampleAnimations(windows: FrameWindow[]): AnimationSample[] {
  const samples: AnimationSample[] = [];
  for (const win of windows) {
    for (const animation of win.document.getAnimations()) {
      const effect = animation.effect as KeyframeEffect | null;
      const target = effect?.target;
      if (!target || animation.startTime === null) continue;
      const rrwebNodeId = record.mirror.getId(target);
      if (rrwebNodeId === -1) continue;
      samples.push({
        rrwebNodeId,
        pseudoElement: effect!.pseudoElement,
        kind: animationKind(animation, win),
        name: animationName(animation, win),
        startEpochMs: win.performance.timeOrigin + Number(animation.startTime)
      });
    }
  }
  return samples;
}

async function encodePoster(source: HTMLCanvasElement): Promise<Blob> {
  const width = Math.min(POSTER_WIDTH, source.width);
  const height = Math.max(
    2,
    Math.round((source.height * width) / source.width / 2) * 2
  );
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d")!.drawImage(source, 0, 0, width, height);
  const webp = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
  if (webp.type === "image/webp") return webp;
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
}

async function posterOrNull(source: HTMLCanvasElement): Promise<Blob | null> {
  try {
    return await encodePoster(source);
  } catch (error) {
    logger.warn(
      "Recording: poster capture failed, finishing without one",
      error
    );
    return null;
  }
}

const FLIP_PROBE_SIZE = 32;
const FLIP_PROBE_TIMEOUT_MS = 1000;
const FLIP_PROBE_WORKER = `onmessage = ({ data }) => {
  const gl = data.canvas.getContext("webgl2", { preserveDrawingBuffer: false });
  const size = data.canvas.height;
  const draw = () => {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, size / 2, size, size / 2);
    gl.clearColor(1, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
  draw();
  setInterval(draw, 16);
};`;

let transferredFlipProbe: Promise<boolean> | null = null;

function frameIsFlipped(frame: VideoFrame): boolean | null {
  const context = new OffscreenCanvas(
    FLIP_PROBE_SIZE,
    FLIP_PROBE_SIZE
  ).getContext("2d", { willReadFrequently: true })!;
  context.drawImage(frame, 0, 0, FLIP_PROBE_SIZE, FLIP_PROBE_SIZE);
  const top = context.getImageData(FLIP_PROBE_SIZE / 2, 4, 1, 1).data;
  const bottom = context.getImageData(
    FLIP_PROBE_SIZE / 2,
    FLIP_PROBE_SIZE - 4,
    1,
    1
  ).data;
  const red = (p: Uint8ClampedArray): boolean => p[0] > 200 && p[2] < 60;
  const blue = (p: Uint8ClampedArray): boolean => p[2] > 200 && p[0] < 60;
  if (red(top) && blue(bottom)) return false;
  if (blue(top) && red(bottom)) return true;
  return null;
}

async function runTransferredFlipProbe(top: FrameWindow): Promise<boolean> {
  const Processor = windowProcessor(top);
  if (!Processor) return false;
  const canvas = top.document.createElement("canvas");
  canvas.width = FLIP_PROBE_SIZE;
  canvas.height = FLIP_PROBE_SIZE;
  const offscreen = canvas.transferControlToOffscreen();
  const url = blobUrl(FLIP_PROBE_WORKER);
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.postMessage({ canvas: offscreen }, [offscreen]);
  const track = canvas
    .captureStream(0)
    .getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const reader = new Processor({ track }).readable.getReader();
  const ticker = setInterval(() => track.requestFrame(), 16);
  const deadline = performance.now() + FLIP_PROBE_TIMEOUT_MS;
  try {
    while (performance.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(
            () => resolve({ done: true, value: undefined }),
            deadline - performance.now()
          )
        )
      ]);
      if (result.done) break;
      const verdict = frameIsFlipped(result.value);
      result.value.close();
      if (verdict !== null) return verdict;
    }
    logger.warn("Recording: transferred-canvas orientation probe inconclusive");
    return false;
  } finally {
    clearInterval(ticker);
    void reader.cancel();
    track.stop();
    worker.terminate();
  }
}

function transferredFramesAreFlipped(top: FrameWindow): Promise<boolean> {
  transferredFlipProbe ??= runTransferredFlipProbe(top).catch((error) => {
    logger.warn(
      "Recording: transferred-canvas orientation probe failed",
      error
    );
    return false;
  });
  return transferredFlipProbe;
}

class Recorder implements ActiveRecording {
  private tracks: TrackCapture[] = [];
  private pacing = new Map<TrackCapture, Pacing>();
  private tap: AudioCaptureTap | null = null;
  private stopRrweb: (() => void) | null = null;
  private events: GzipJsonArrayWriter | null = null;
  private animations: AnimationSample[] = [];
  private timeZeroMs = 0;
  private clockSkewMs = 0;
  private hasDom = false;
  private fps = REQUEST_FRAME_FPS;
  private posterSource: HTMLCanvasElement | null = null;
  private posterResolve: ((poster: Promise<Blob | null>) => void) | null = null;
  private nextGrab = new Map<FrameWindow, number>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private aborted: Promise<never>;
  private rejectAborted!: (error: Error) => void;

  constructor(private readonly host: RecorderHost) {
    this.aborted = new Promise<never>((_, reject) => {
      this.rejectAborted = reject;
    });
    this.aborted.catch(() => undefined);
  }

  async start(): Promise<boolean> {
    const { top, windows, session } = this.host;
    const canvases = findCaptureCanvases(windows, top);
    if (canvases.length === 0) {
      session.failed("No game canvas found.", "no-canvas");
      return false;
    }
    this.hasDom = detectHasDom(windows, top, canvases);
    this.clockSkewMs = Date.now() - epochNow();
    const workerUrl = blobUrl(workerSource);
    try {
      const mode = await this.selectMode(top, workerUrl);
      this.fps =
        mode === "media-recorder" ? MEDIA_RECORDER_FPS : REQUEST_FRAME_FPS;
      const transferred = canvases.map((target) =>
        isTransferredCanvas(target.canvas)
      );
      const flipTransferred =
        mode !== "media-recorder" && transferred.includes(true)
          ? await transferredFramesAreFlipped(top)
          : false;
      this.tap = this.host.createAudioTap();
      const settled = await Promise.allSettled(
        canvases.map((target, index) =>
          this.openTrack(
            index,
            target,
            mode,
            workerUrl,
            transferred[index] && flipTransferred
          )
        )
      );
      const opened = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : []
      );
      const failure = settled.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected"
      );
      if (failure) {
        opened.forEach((track) => track.dispose());
        throw failure.reason;
      }
      this.tracks = opened;
    } finally {
      URL.revokeObjectURL(workerUrl);
    }
    this.posterSource = this.tracks[0].canvas;
    if (this.hasDom) {
      this.events = new GzipJsonArrayWriter();
      this.stopRrweb = record<eventWithTime>({
        emit: (event) => {
          if (this.events!.length === 0) this.timeZeroMs = event.timestamp;
          this.events!.push(event);
          if (event.type === EventType.FullSnapshot) {
            this.animations.push(...sampleAnimations(windows));
          }
        },
        recordCanvas: false,
        blockSelector: WAVEDASH_UI_BLOCK_SELECTOR,
        maskAllInputs: true
      })!;
      if (this.events.length === 0) {
        throw new Error("rrweb emitted no events at start");
      }
    } else {
      this.timeZeroMs = Date.now();
    }
    const startedMs = performance.now();
    for (const track of this.tracks) {
      this.pacing.set(track, {
        lastTailGrabMs: startedMs,
        timer: null,
        warnedDetached: false
      });
    }
    const tailWindows = new Set(this.tracks.map((track) => track.win));
    this.host.rafTail.start(tailWindows, this.onTail);
    this.watchdog = setInterval(this.checkPacing, WATCHDOG_INTERVAL_MS);
    this.deadline = setTimeout(this.checkFirstFrames, FIRST_FRAME_DEADLINE_MS);
    session.started(this.tracks.length, this.hasDom);
    return true;
  }

  private async selectMode(
    top: FrameWindow,
    workerUrl: string
  ): Promise<CaptureMode> {
    if (!canRequestFrame(top)) return "media-recorder";
    if (windowProcessor(top)) return "stream";
    const probe = new WorkerChannel(
      workerUrl,
      () => {},
      (message) => this.abort(message)
    );
    try {
      probe.send({ type: "probe" });
      const caps = await probe.next("caps");
      return caps.workerMstp ? "track" : "media-recorder";
    } finally {
      probe.worker.terminate();
    }
  }

  private openTrack(
    index: number,
    target: CaptureCanvas,
    mode: CaptureMode,
    workerUrl: string,
    flipY: boolean
  ): Promise<TrackCapture> {
    const tap = index === 0 ? this.tap : null;
    const onPart = (data: ArrayBuffer): void => {
      if (this.disposed || !this.host.session.isOpen) return;
      this.host.session.data(`${index}.mp4`, data, false);
    };
    const onError = (message: string): void =>
      this.abort(`Track ${index}: ${message}`);
    if (mode === "media-recorder") {
      return Promise.resolve().then(() =>
        openMediaRecorderTrack(index, target, tap, onPart, onError)
      );
    }
    const channel = new WorkerChannel(workerUrl, onPart, onError);
    return openWorkerTrack(index, target, mode, channel, tap, flipY);
  }

  private onTail = (win: FrameWindow, timestamp: number, gameRan: boolean) => {
    if (
      this.posterResolve &&
      this.posterSource!.ownerDocument.defaultView === win
    ) {
      const resolve = this.posterResolve;
      this.posterResolve = null;
      resolve(posterOrNull(this.posterSource!));
    }
    if (!gameRan) return;
    const period = 1000 / this.fps;
    const next = this.nextGrab.get(win) ?? -Infinity;
    if (timestamp < next - period / 2) return;
    this.nextGrab.set(
      win,
      timestamp - next > period ? timestamp + period : next + period
    );
    const now = performance.now();
    for (const track of this.tracks) {
      if (track.win !== win || !track.requestFrame) continue;
      const pacing = this.pacing.get(track)!;
      if (pacing.timer !== null) {
        clearInterval(pacing.timer);
        pacing.timer = null;
      }
      pacing.lastTailGrabMs = now;
      track.requestFrame();
    }
  };

  private checkPacing = (): void => {
    const now = performance.now();
    for (const track of this.tracks) {
      const pacing = this.pacing.get(track)!;
      if (!pacing.warnedDetached && !track.canvas.isConnected) {
        pacing.warnedDetached = true;
        logger.warn(
          `Recording: canvas for track ${track.index} was removed from the page; the track keeps its last frame`
        );
      }
      const requestFrame = track.requestFrame;
      if (!requestFrame || pacing.timer !== null) continue;
      if (now - pacing.lastTailGrabMs < TAIL_WATCHDOG_MS) continue;
      logger.warn(
        `Recording: no game requestAnimationFrame seen for track ${track.index}; capturing on a ${this.fps} fps timer`
      );
      pacing.timer = setInterval(requestFrame, 1000 / this.fps);
    }
  };

  private checkFirstFrames = (): void => {
    this.deadline = null;
    const silent = this.tracks.filter((track) => !track.hasFirstFrame());
    if (silent.length === 0) return;
    this.abort(
      `No frames captured from canvas ${silent
        .map((track) => `#${track.index}`)
        .join(", ")} within ${FIRST_FRAME_DEADLINE_MS} ms`,
      "no-frames"
    );
  };

  private stopPacing(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    if (this.deadline !== null) clearTimeout(this.deadline);
    this.watchdog = null;
    this.deadline = null;
    this.pacing.forEach((pacing) => {
      if (pacing.timer !== null) clearInterval(pacing.timer);
      pacing.timer = null;
    });
    this.host.rafTail.stop();
  }

  private capturePoster(): Promise<Blob | null> {
    return new Promise<Promise<Blob | null>>((resolve) => {
      this.posterResolve = resolve;
      setTimeout(() => {
        if (this.posterResolve !== resolve) return;
        this.posterResolve = null;
        resolve(posterOrNull(this.posterSource!));
      }, POSTER_TAIL_TIMEOUT_MS);
    }).then((poster) => poster);
  }

  private resolveNodeIds(): (number | undefined)[] {
    return this.tracks.map((track) => {
      const id = record.mirror.getId(track.canvas);
      if (id !== -1) return id;
      logger.warn(
        `Recording: canvas for track ${track.index} is not in the rrweb mirror; manifest omits its rrwebNodeId`
      );
      return undefined;
    });
  }

  async stop(): Promise<void> {
    const { session, top } = this.host;
    const stopMs = Date.now();
    const poster = await this.capturePoster();
    this.stopPacing();
    const nodeIds = this.hasDom ? this.resolveNodeIds() : null;
    this.stopRrweb?.();
    this.stopRrweb = null;
    const results = await Promise.race([
      Promise.all(this.tracks.map((track) => track.finish())),
      this.aborted
    ]);
    this.tap?.dispose();
    this.tap = null;
    if (this.disposed || !session.isOpen) return;
    results.forEach((result, index) =>
      session.data(`${index}.mp4`, result.remainder, true)
    );
    if (this.events) {
      const events = this.events;
      this.events = null;
      session.data("dom.json.gz", await events.finish(), true);
    }
    const captured: CapturedTrack[] = this.tracks.map((track, index) => ({
      index,
      ...(nodeIds?.[index] !== undefined && { rrwebNodeId: nodeIds[index] }),
      width: track.width,
      height: track.height,
      firstFrameEpochMs: results[index].firstFrameEpochMs + this.clockSkewMs
    }));
    const manifest = buildManifest({
      fps: this.fps,
      timeZeroEpochMs: this.timeZeroMs,
      stopEpochMs: stopMs,
      viewport: {
        width: top.innerWidth,
        height: top.innerHeight,
        dpr: top.devicePixelRatio
      },
      tracks: captured,
      ...(this.hasDom && { animations: this.animations })
    });
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    session.data("manifest.json", manifestBytes.buffer as ArrayBuffer, true);
    const size = this.hasDom
      ? fitToEncodeBox(
          Math.round(top.innerWidth * top.devicePixelRatio),
          Math.round(top.innerHeight * top.devicePixelRatio)
        )
      : { width: this.tracks[0].width, height: this.tracks[0].height };
    session.finished({
      durationMs: manifest.durationMs,
      width: size.width,
      height: size.height,
      poster
    });
    this.disposed = true;
  }

  abort(error: string, reason?: RecordingFailureReason): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAborted(new Error(error));
    this.host.session.failed(error, reason);
    this.stopPacing();
    this.stopRrweb?.();
    this.stopRrweb = null;
    this.events?.abort();
    this.events = null;
    this.tracks.forEach((track) => track.dispose());
    this.tap?.dispose();
    this.tap = null;
  }
}

export async function startRecording(
  host: RecorderHost
): Promise<ActiveRecording | null> {
  const recorder = new Recorder(host);
  try {
    return (await recorder.start()) ? recorder : null;
  } catch (error) {
    recorder.abort(errorText(error));
    return null;
  }
}
