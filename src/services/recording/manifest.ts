export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export interface ManifestTrack {
  index: number;
  rrwebNodeId?: number;
  width: number;
  height: number;
  startOffsetMs: number;
}

export type AnimationKind =
  | "css-animation"
  | "css-transition"
  | "web-animation";

export interface AnimationStart {
  rrwebNodeId: number;
  pseudoElement: string | null;
  kind: AnimationKind;
  name: string;
  startOffsetMs: number;
}

export interface RecordingManifest {
  version: 1;
  fps: number;
  durationMs: number;
  viewport: Viewport;
  tracks: ManifestTrack[];
  animationStarts?: AnimationStart[];
}

export interface CapturedTrack {
  index: number;
  rrwebNodeId?: number;
  width: number;
  height: number;
  firstFrameEpochMs: number;
}

export interface AnimationSample {
  rrwebNodeId: number;
  pseudoElement: string | null;
  kind: AnimationKind;
  name: string;
  startEpochMs: number;
}

const round = (ms: number): number => Math.round(ms * 1000) / 1000;

export function buildManifest(input: {
  fps: number;
  timeZeroEpochMs: number;
  stopEpochMs: number;
  viewport: Viewport;
  tracks: CapturedTrack[];
  animations?: AnimationSample[];
}): RecordingManifest {
  const durationMs = input.stopEpochMs - input.timeZeroEpochMs;
  if (!(durationMs > 0)) {
    throw new Error(`Recording duration must be positive, got ${durationMs}`);
  }
  const tracks = [...input.tracks]
    .sort((a, b) => a.index - b.index)
    .map((track, position) => {
      if (track.index !== position) {
        throw new Error(`Track indices must be 0..n-1, got ${track.index}`);
      }
      return {
        index: track.index,
        ...(track.rrwebNodeId !== undefined && {
          rrwebNodeId: track.rrwebNodeId
        }),
        width: track.width,
        height: track.height,
        startOffsetMs: round(track.firstFrameEpochMs - input.timeZeroEpochMs)
      };
    });
  return {
    version: 1,
    fps: input.fps,
    durationMs: round(durationMs),
    viewport: input.viewport,
    tracks,
    ...(input.animations && {
      animationStarts: input.animations.map((animation) => ({
        rrwebNodeId: animation.rrwebNodeId,
        pseudoElement: animation.pseudoElement,
        kind: animation.kind,
        name: animation.name,
        startOffsetMs: round(animation.startEpochMs - input.timeZeroEpochMs)
      }))
    })
  };
}
