import { describe, expect, it } from "vitest";
import { buildManifest } from "../../../services/recording/manifest";

const viewport = { width: 1280, height: 720, dpr: 2 };

describe("buildManifest", () => {
  it("measures offsets from time zero and orders tracks", () => {
    const manifest = buildManifest({
      fps: 60,
      timeZeroEpochMs: 1_000_000,
      stopEpochMs: 1_012_500.25,
      viewport,
      tracks: [
        {
          index: 1,
          rrwebNodeId: 42,
          width: 256,
          height: 256,
          firstFrameEpochMs: 1_000_033.3334
        },
        {
          index: 0,
          rrwebNodeId: 7,
          width: 1920,
          height: 1080,
          firstFrameEpochMs: 1_000_016.5
        }
      ],
      animations: [
        {
          rrwebNodeId: 9,
          pseudoElement: "::after",
          kind: "css-animation",
          name: "pulse",
          startEpochMs: 999_500
        }
      ]
    });
    expect(manifest).toEqual({
      version: 1,
      fps: 60,
      durationMs: 12_500.25,
      viewport,
      tracks: [
        {
          index: 0,
          rrwebNodeId: 7,
          width: 1920,
          height: 1080,
          startOffsetMs: 16.5
        },
        {
          index: 1,
          rrwebNodeId: 42,
          width: 256,
          height: 256,
          startOffsetMs: 33.333
        }
      ],
      animationStarts: [
        {
          rrwebNodeId: 9,
          pseudoElement: "::after",
          kind: "css-animation",
          name: "pulse",
          startOffsetMs: -500
        }
      ]
    });
  });

  it("omits DOM-only fields for canvas-only recordings", () => {
    const manifest = buildManifest({
      fps: 30,
      timeZeroEpochMs: 10,
      stopEpochMs: 1010,
      viewport,
      tracks: [{ index: 0, width: 640, height: 480, firstFrameEpochMs: 20 }]
    });
    expect(manifest.tracks[0]).toEqual({
      index: 0,
      width: 640,
      height: 480,
      startOffsetMs: 10
    });
    expect(manifest).not.toHaveProperty("animationStarts");
  });

  it("rejects gaps in track indices and non-positive durations", () => {
    const track = { width: 2, height: 2, firstFrameEpochMs: 1 };
    expect(() =>
      buildManifest({
        fps: 60,
        timeZeroEpochMs: 0,
        stopEpochMs: 10,
        viewport,
        tracks: [{ index: 1, ...track }]
      })
    ).toThrow(/indices/);
    expect(() =>
      buildManifest({
        fps: 60,
        timeZeroEpochMs: 10,
        stopEpochMs: 10,
        viewport,
        tracks: [{ index: 0, ...track }]
      })
    ).toThrow(/duration/);
  });
});
