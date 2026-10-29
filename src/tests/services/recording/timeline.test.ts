import { describe, expect, it } from "vitest";
import {
  AudioTimeline,
  MAX_AUDIO_LEAD_SECONDS,
  VideoTimeline
} from "../../../services/recording/timeline";

describe("VideoTimeline", () => {
  it("uses source timestamps relative to the first frame", () => {
    const timeline = new VideoTimeline();
    for (const raw of [5_000, 21_667, 38_333]) timeline.observe(raw);
    expect(timeline.stamp(5_000, 900)).toBe(0);
    expect(timeline.stamp(21_667, 999_999)).toBe(16_667);
    expect(timeline.stamp(38_333, 1)).toBe(33_333);
    expect(timeline.usesArrivalTime).toBe(false);
  });

  it("switches to arrival time when source timestamps stop advancing", () => {
    const timeline = new VideoTimeline();
    timeline.observe(0);
    expect(timeline.stamp(0, 1_000_000)).toBe(0);
    timeline.observe(0);
    expect(timeline.usesArrivalTime).toBe(true);
    expect(timeline.stamp(0, 1_016_700)).toBe(16_700);
  });

  it("never emits a timestamp that is not strictly increasing", () => {
    const timeline = new VideoTimeline();
    timeline.observe(100_000);
    expect(timeline.stamp(100_000, 0)).toBe(0);
    timeline.observe(150_000);
    expect(timeline.stamp(150_000, 50_000)).toBe(50_000);
    timeline.observe(90_000);
    expect(timeline.stamp(90_000, 20_000)).toBe(50_001);
    timeline.observe(91_000);
    expect(timeline.stamp(91_000, 70_000)).toBe(70_000);
  });
});

describe("AudioTimeline", () => {
  it("fills silence up to a clock offset", () => {
    const timeline = new AudioTimeline(48_000);
    expect(timeline.silenceUntil(100_000)).toBe(4_800);
    timeline.advance(4_800);
    expect(timeline.timestampUs).toBe(100_000);
    expect(timeline.silenceUntil(50_000)).toBe(0);
  });

  it("places a block so it ends at its arrival time", () => {
    const timeline = new AudioTimeline(48_000);
    expect(timeline.placeBlock(1_000_000, 2_048)).toEqual({
      silence: 48_000 - 2_048,
      accept: true
    });
  });

  it("appends a late block without extra silence", () => {
    const timeline = new AudioTimeline(48_000);
    timeline.advance(48_000);
    expect(timeline.placeBlock(990_000, 2_048)).toEqual({
      silence: 0,
      accept: true
    });
  });

  it("drops blocks once audio runs too far ahead of the clock", () => {
    const timeline = new AudioTimeline(48_000);
    timeline.advance(48_000 * (MAX_AUDIO_LEAD_SECONDS + 1));
    expect(timeline.placeBlock(500_000, 2_048).accept).toBe(false);
  });
});
