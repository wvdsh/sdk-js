export interface MediaStreamTrackProcessorInit {
  track: MediaStreamTrack;
}

export interface MediaStreamTrackProcessorInstance {
  readable: ReadableStream<VideoFrame>;
}

export type MediaStreamTrackProcessorConstructor = new (
  init: MediaStreamTrackProcessorInit
) => MediaStreamTrackProcessorInstance;

export type ToWorker =
  | { type: "probe" }
  | {
      type: "init";
      sourceWidth: number;
      sourceHeight: number;
      fps: number;
      audioSampleRate: number | null;
      flipY: boolean;
    }
  | { type: "readable"; readable: ReadableStream<VideoFrame> }
  | { type: "track"; track: MediaStreamTrack }
  | { type: "audio"; port: MessagePort }
  | { type: "stop" };

export type FromWorker =
  | { type: "caps"; workerMstp: boolean }
  | {
      type: "ready";
      width: number;
      height: number;
      codec: string;
      audio: boolean;
    }
  | { type: "first-frame" }
  | { type: "warn"; message: string }
  | { type: "part"; data: ArrayBuffer }
  | {
      type: "done";
      remainder: ArrayBuffer;
      firstFrameEpochMs: number;
      frames: number;
      droppedFrames: number;
      letterboxedFrames: number;
      letterboxMs: number;
      audioPackets: number;
      audioSilenceFrames: number;
      audioDisabled: boolean;
    }
  | { type: "error"; message: string };

export interface AudioBlock {
  channels: Float32Array[];
  sampleRate: number;
}

export const AUDIO_WORKLET_NAME = "wavedash-capture-tap";

export const AUDIO_WORKLET_SOURCE = `
const BLOCK_FRAMES = 2048;
class CaptureTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = null;
    this.filled = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    if (!this.channels || this.channels.length !== input.length) {
      this.channels = input.map(() => new Float32Array(BLOCK_FRAMES));
      this.filled = 0;
    }
    let offset = 0;
    const frames = input[0].length;
    while (offset < frames) {
      const count = Math.min(BLOCK_FRAMES - this.filled, frames - offset);
      for (let c = 0; c < input.length; c++) {
        this.channels[c].set(input[c].subarray(offset, offset + count), this.filled);
      }
      this.filled += count;
      offset += count;
      if (this.filled === BLOCK_FRAMES) {
        const channels = this.channels;
        this.port.postMessage({ channels, sampleRate }, channels.map((c) => c.buffer));
        this.channels = input.map(() => new Float32Array(BLOCK_FRAMES));
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("${AUDIO_WORKLET_NAME}", CaptureTapProcessor);
`;
