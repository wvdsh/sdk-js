import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
  StreamTarget
} from "mediabunny";
import {
  audioSpecificConfig,
  avcCodecString,
  bitrateFor,
  fitToEncodeBox,
  letterbox
} from "./codec";
import { PART_SIZE, PartChunker } from "./parts";
import { AudioTimeline, VideoTimeline } from "./timeline";
import type {
  AudioBlock,
  FromWorker,
  MediaStreamTrackProcessorConstructor,
  ToWorker
} from "./workerProtocol";

const KEYFRAME_INTERVAL_US = 1_000_000;
const MAX_ENCODE_QUEUE = 2;
const AUDIO_CODEC = "mp4a.40.2";
const AUDIO_BITRATE = 128_000;
const AUDIO_CHANNELS = 2;
const SILENCE_CHUNK_FRAMES = 1024;
const AUDIO_CLOCK_MS = 50;
const AUDIO_CLOCK_LAG_US = 200_000;

const scope = self as unknown as Worker;
const epochNow = (): number => performance.timeOrigin + performance.now();

function send(message: FromWorker, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

interface AudioPipeline {
  source: EncodedAudioPacketSource;
  encoder: AudioEncoder;
  timeline: AudioTimeline;
  clock: ReturnType<typeof setInterval> | null;
  port: MessagePort | null;
  packets: number;
  silenceFrames: number;
  disabled: boolean;
}

interface Recording {
  width: number;
  height: number;
  encoder: VideoEncoder;
  output: Output;
  video: EncodedVideoPacketSource;
  audio: AudioPipeline | null;
  chunker: PartChunker;
  mux: Promise<void>;
  warmMeta: EncodedVideoChunkMetadata | undefined;
  warming: boolean;
  videoPackets: number;
  frames: number;
  droppedFrames: number;
  letterboxedFrames: number;
  letterboxMs: number;
  letterboxContext: OffscreenCanvasRenderingContext2D | null;
  flipY: boolean;
  timeline: VideoTimeline;
  firstFrameEpochMs: number | null;
  lastKeyTimestamp: number;
  reader: ReadableStreamDefaultReader<VideoFrame> | null;
  track: MediaStreamTrack | null;
  stopping: boolean;
  failed: boolean;
}

let recording: Recording | null = null;

function fail(error: unknown): void {
  if (recording) {
    if (recording.failed) return;
    recording.failed = true;
  }
  send({ type: "error", message: errorText(error) });
}

function enqueueMux(
  rec: Recording,
  task: () => Promise<void>,
  onError: (error: unknown) => void = fail
): void {
  rec.mux = rec.mux.then(task).catch(onError);
}

function disableAudio(rec: Recording, reason: unknown): void {
  const audio = rec.audio!;
  if (audio.disabled) return;
  audio.disabled = true;
  if (audio.clock !== null) clearInterval(audio.clock);
  if (audio.port) audio.port.onmessage = null;
  if (audio.encoder.state !== "closed") audio.encoder.close();
  send({
    type: "warn",
    message: `Audio disabled, video continues: ${errorText(reason)}`
  });
  enqueueMux(rec, async () => audio.source.close());
}

function encodeAudio(
  rec: Recording,
  channels: Float32Array[] | null,
  frames: number
): void {
  const audio = rec.audio!;
  const planar = new Float32Array(frames * AUDIO_CHANNELS);
  if (channels) {
    for (let c = 0; c < AUDIO_CHANNELS; c++) {
      planar.set(channels[Math.min(c, channels.length - 1)], c * frames);
    }
  }
  const data = new AudioData({
    format: "f32-planar",
    sampleRate: audio.timeline.sampleRate,
    numberOfFrames: frames,
    numberOfChannels: AUDIO_CHANNELS,
    timestamp: audio.timeline.timestampUs,
    data: planar
  });
  audio.timeline.advance(frames);
  audio.encoder.encode(data);
  data.close();
}

function encodeSilence(rec: Recording, frames: number): void {
  const audio = rec.audio!;
  audio.silenceFrames += frames;
  for (let left = frames; left > 0; left -= SILENCE_CHUNK_FRAMES) {
    encodeAudio(rec, null, Math.min(SILENCE_CHUNK_FRAMES, left));
  }
}

function guardAudio(rec: Recording, action: () => void): void {
  if (!rec.audio || rec.audio.disabled) return;
  try {
    action();
  } catch (error) {
    disableAudio(rec, error);
  }
}

function fillSilence(rec: Recording, lagUs: number): void {
  guardAudio(rec, () => {
    const offsetUs = (epochNow() - rec.firstFrameEpochMs!) * 1000 - lagUs;
    encodeSilence(rec, rec.audio!.timeline.silenceUntil(offsetUs));
  });
}

async function createAudio(
  rec: Recording,
  sampleRate: number
): Promise<AudioPipeline | null> {
  const config: AudioEncoderConfig = {
    codec: AUDIO_CODEC,
    sampleRate,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE
  };
  if (typeof AudioEncoder === "undefined") return null;
  const support = await AudioEncoder.isConfigSupported(config).catch(
    () => null
  );
  if (!support?.supported) return null;
  const source = new EncodedAudioPacketSource("aac");
  const pipeline: AudioPipeline = {
    source,
    encoder: null!,
    timeline: new AudioTimeline(sampleRate),
    clock: null,
    port: null,
    packets: 0,
    silenceFrames: 0,
    disabled: false
  };
  pipeline.encoder = new AudioEncoder({
    output: (chunk, meta) => {
      pipeline.packets++;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      const description = meta?.decoderConfig?.description;
      const packetMeta = description
        ? {
            ...meta,
            decoderConfig: {
              ...meta.decoderConfig!,
              description: audioSpecificConfig(
                ArrayBuffer.isView(description)
                  ? new Uint8Array(
                      description.buffer,
                      description.byteOffset,
                      description.byteLength
                    )
                  : new Uint8Array(description)
              )
            }
          }
        : meta;
      enqueueMux(
        rec,
        () => source.add(packet, packetMeta),
        (error) => disableAudio(rec, error)
      );
    },
    error: (error) => disableAudio(rec, error)
  });
  pipeline.encoder.configure(config);
  return pipeline;
}

async function init(
  message: Extract<ToWorker, { type: "init" }>
): Promise<void> {
  const { width, height } = fitToEncodeBox(
    message.sourceWidth,
    message.sourceHeight
  );
  const config: VideoEncoderConfig = {
    codec: avcCodecString(width, height, message.fps),
    width,
    height,
    bitrate: bitrateFor(width, height),
    framerate: message.fps,
    latencyMode: "realtime",
    hardwareAcceleration: "no-preference",
    avc: { format: "avc" }
  };
  const support = await VideoEncoder.isConfigSupported(config);
  if (!support.supported) {
    throw new Error(`VideoEncoder rejected ${config.codec} ${width}x${height}`);
  }
  const video = new EncodedVideoPacketSource("avc");
  const rec: Recording = {
    width,
    height,
    encoder: null!,
    output: null!,
    video,
    audio: null,
    chunker: new PartChunker((part) =>
      send({ type: "part", data: part }, [part])
    ),
    mux: Promise.resolve(),
    warmMeta: undefined,
    warming: true,
    videoPackets: 0,
    frames: 0,
    droppedFrames: 0,
    letterboxedFrames: 0,
    letterboxMs: 0,
    letterboxContext: null,
    flipY: message.flipY,
    timeline: new VideoTimeline(),
    firstFrameEpochMs: null,
    lastKeyTimestamp: -Infinity,
    reader: null,
    track: null,
    stopping: false,
    failed: false
  };
  rec.audio =
    message.audioSampleRate === null
      ? null
      : await createAudio(rec, message.audioSampleRate);
  rec.output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented" }),
    target: new StreamTarget(
      new WritableStream({
        write: (chunk) => rec.chunker.write(chunk.data, chunk.position)
      }),
      { chunked: true, chunkSize: PART_SIZE }
    )
  });
  rec.output.addVideoTrack(video);
  if (rec.audio) rec.output.addAudioTrack(rec.audio.source);
  await rec.output.start();
  rec.encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (rec.warming) {
        rec.warmMeta = meta;
        return;
      }
      const packetMeta =
        rec.videoPackets === 0 && !meta?.decoderConfig ? rec.warmMeta : meta;
      rec.videoPackets++;
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      enqueueMux(rec, () => video.add(packet, packetMeta));
    },
    error: fail
  });
  rec.encoder.configure(config);
  const warmCanvas = new OffscreenCanvas(width, height);
  warmCanvas.getContext("2d")!.fillRect(0, 0, width, height);
  const warmFrame = new VideoFrame(warmCanvas, { timestamp: 0 });
  rec.encoder.encode(warmFrame, { keyFrame: true });
  warmFrame.close();
  await rec.encoder.flush();
  rec.warming = false;
  recording = rec;
  send({
    type: "ready",
    width,
    height,
    codec: config.codec,
    audio: rec.audio !== null
  });
}

function fitFrame(rec: Recording, frame: VideoFrame, timestamp: number) {
  const placement = letterbox(
    frame.displayWidth,
    frame.displayHeight,
    rec.width,
    rec.height
  );
  if (!placement && !rec.flipY) return new VideoFrame(frame, { timestamp });
  const started = performance.now();
  rec.letterboxContext ??= new OffscreenCanvas(
    rec.width,
    rec.height
  ).getContext("2d", { alpha: false })!;
  const context = rec.letterboxContext;
  const target = placement ?? {
    x: 0,
    y: 0,
    width: rec.width,
    height: rec.height
  };
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.fillStyle = "#000";
  context.fillRect(0, 0, rec.width, rec.height);
  if (rec.flipY) context.setTransform(1, 0, 0, -1, 0, rec.height);
  context.drawImage(frame, target.x, target.y, target.width, target.height);
  const boxed = new VideoFrame(context.canvas, { timestamp });
  rec.letterboxedFrames++;
  rec.letterboxMs += performance.now() - started;
  return boxed;
}

function onVideoFrame(rec: Recording, frame: VideoFrame): void {
  const arrival = epochNow();
  if (rec.stopping || rec.failed) {
    frame.close();
    return;
  }
  rec.timeline.observe(frame.timestamp);
  if (rec.encoder.encodeQueueSize > MAX_ENCODE_QUEUE) {
    rec.droppedFrames++;
    frame.close();
    return;
  }
  if (rec.firstFrameEpochMs === null) {
    rec.firstFrameEpochMs = arrival;
    send({ type: "first-frame" });
    const audio = rec.audio;
    if (audio && !audio.disabled) {
      audio.clock = setInterval(
        () => fillSilence(rec, AUDIO_CLOCK_LAG_US),
        AUDIO_CLOCK_MS
      );
    }
  }
  const timestamp = rec.timeline.stamp(frame.timestamp, arrival * 1000);
  const keyFrame = timestamp - rec.lastKeyTimestamp >= KEYFRAME_INTERVAL_US;
  if (keyFrame) rec.lastKeyTimestamp = timestamp;
  const stamped = fitFrame(rec, frame, timestamp);
  frame.close();
  rec.encoder.encode(stamped, { keyFrame });
  stamped.close();
  rec.frames++;
}

async function pump(rec: Recording, readable: ReadableStream<VideoFrame>) {
  const reader = readable.getReader();
  rec.reader = reader;
  for (;;) {
    const result = await reader.read();
    if (result.done) return;
    onVideoFrame(rec, result.value);
  }
}

function startAudio(rec: Recording, port: MessagePort): void {
  const audio = rec.audio;
  if (!audio) throw new Error("Audio port sent to a video-only track");
  audio.port = port;
  port.onmessage = ({ data }: MessageEvent<AudioBlock>) => {
    if (rec.stopping || rec.failed || rec.firstFrameEpochMs === null) return;
    guardAudio(rec, () => {
      if (data.sampleRate !== audio.timeline.sampleRate) {
        throw new Error(
          `Audio block at ${data.sampleRate} Hz, encoder configured for ${audio.timeline.sampleRate} Hz`
        );
      }
      const frames = data.channels[0].length;
      const offsetUs = (epochNow() - rec.firstFrameEpochMs!) * 1000;
      const placement = audio.timeline.placeBlock(offsetUs, frames);
      encodeSilence(rec, placement.silence);
      if (placement.accept) encodeAudio(rec, data.channels, frames);
    });
  };
}

async function stop(rec: Recording): Promise<void> {
  rec.stopping = true;
  await rec.reader?.cancel();
  rec.track?.stop();
  await rec.encoder.flush();
  rec.encoder.close();
  const audio = rec.audio;
  if (audio && !audio.disabled) {
    if (audio.clock !== null) clearInterval(audio.clock);
    if (audio.port) audio.port.onmessage = null;
    if (rec.firstFrameEpochMs !== null) fillSilence(rec, 0);
    try {
      await audio.encoder.flush();
      audio.encoder.close();
    } catch (error) {
      disableAudio(rec, error);
    }
  }
  await rec.mux;
  if (rec.failed) return;
  if (rec.firstFrameEpochMs === null) throw new Error("No frames captured");
  await rec.output.finalize();
  const remainder = rec.chunker.finish();
  send(
    {
      type: "done",
      remainder,
      firstFrameEpochMs: rec.firstFrameEpochMs,
      frames: rec.frames,
      droppedFrames: rec.droppedFrames,
      letterboxedFrames: rec.letterboxedFrames,
      letterboxMs: Math.round(rec.letterboxMs),
      audioPackets: audio?.packets ?? 0,
      audioSilenceFrames: audio?.silenceFrames ?? 0,
      audioDisabled: audio?.disabled ?? true
    },
    [remainder]
  );
}

scope.onmessage = async ({ data }: MessageEvent<ToWorker>) => {
  try {
    if (data.type === "probe") {
      send({
        type: "caps",
        workerMstp:
          typeof (self as unknown as { MediaStreamTrackProcessor?: unknown })
            .MediaStreamTrackProcessor !== "undefined"
      });
      return;
    }
    if (data.type === "init") {
      await init(data);
      return;
    }
    const rec = recording;
    if (!rec) throw new Error(`Worker received ${data.type} before init`);
    if (data.type === "readable") {
      await pump(rec, data.readable);
    } else if (data.type === "track") {
      const Processor = (
        self as unknown as {
          MediaStreamTrackProcessor: MediaStreamTrackProcessorConstructor;
        }
      ).MediaStreamTrackProcessor;
      rec.track = data.track;
      await pump(rec, new Processor({ track: data.track }).readable);
    } else if (data.type === "audio") {
      startAudio(rec, data.port);
    } else {
      await stop(rec);
    }
  } catch (error) {
    fail(error);
  }
};
