import { describe, expect, it } from "vitest";
import {
  audioSpecificConfig,
  avcCodecString,
  bitrateFor,
  fitToEncodeBox,
  letterbox
} from "../../../services/recording/codec";

describe("avcCodecString", () => {
  it.each([
    [1280, 720, 60, "avc1.640020"],
    [1600, 900, 60, "avc1.64002A"],
    [1920, 1080, 60, "avc1.64002A"],
    [1920, 1080, 30, "avc1.640028"],
    [1920, 1450, 60, "avc1.640033"],
    [3200, 1800, 60, "avc1.640034"],
    [256, 256, 60, "avc1.64001E"],
    [128, 128, 30, "avc1.64001E"]
  ])("%ix%i@%i -> %s", (width, height, fps, codec) => {
    expect(avcCodecString(width, height, fps)).toBe(codec);
  });

  it("throws when no level fits", () => {
    expect(() => avcCodecString(16384, 16384, 60)).toThrow(/No H.264 level/);
  });
});

describe("fitToEncodeBox", () => {
  it("keeps sources inside the box", () => {
    expect(fitToEncodeBox(1600, 900)).toEqual({ width: 1600, height: 900 });
  });

  it("scales landscape sources into 1920x1080 with even dimensions", () => {
    expect(fitToEncodeBox(3200, 1800)).toEqual({ width: 1920, height: 1080 });
    expect(fitToEncodeBox(1920, 1450)).toEqual({ width: 1430, height: 1080 });
    expect(fitToEncodeBox(3001, 1001)).toEqual({ width: 1920, height: 640 });
  });

  it("uses a portrait box for portrait sources", () => {
    expect(fitToEncodeBox(1440, 2560)).toEqual({ width: 1080, height: 1920 });
  });

  it("rounds odd sizes to even", () => {
    expect(fitToEncodeBox(301, 151)).toEqual({ width: 302, height: 152 });
  });

  it("rejects empty sources", () => {
    expect(() => fitToEncodeBox(0, 100)).toThrow();
  });
});

describe("bitrateFor", () => {
  it("scales with area between 1 and 10 Mbps", () => {
    expect(bitrateFor(1920, 1080)).toBe(10_000_000);
    expect(bitrateFor(3840, 2160)).toBe(10_000_000);
    expect(bitrateFor(256, 256)).toBe(1_000_000);
    expect(bitrateFor(1280, 720)).toBe(4_444_444);
  });
});

describe("audioSpecificConfig", () => {
  it("passes a bare AudioSpecificConfig through", () => {
    const asc = Uint8Array.from([0x11, 0x90]);
    expect(audioSpecificConfig(asc)).toBe(asc);
  });

  it("extracts the AudioSpecificConfig from WebKit's full esds descriptor", () => {
    const esds = Uint8Array.from([
      0x03, 0x80, 0x80, 0x80, 0x22, 0x00, 0x00, 0x00, 0x04, 0x80, 0x80, 0x80,
      0x14, 0x40, 0x14, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x05, 0x80, 0x80, 0x80, 0x02, 0x11, 0x90, 0x06, 0x80, 0x80,
      0x80, 0x01, 0x02
    ]);
    expect(Array.from(audioSpecificConfig(esds))).toEqual([0x11, 0x90]);
  });

  it("throws when an esds descriptor carries no AudioSpecificConfig", () => {
    expect(() =>
      audioSpecificConfig(Uint8Array.from([0x03, 0x03, 0x00, 0x00, 0x00]))
    ).toThrow(/no AudioSpecificConfig/);
  });
});

describe("letterbox", () => {
  it("leaves frames within 1% of the encoder aspect to the encoder", () => {
    expect(letterbox(3200, 1800, 1920, 1080)).toBeNull();
    expect(letterbox(1910, 1080, 1920, 1080)).toBeNull();
  });

  it("pillarboxes a narrower frame", () => {
    expect(letterbox(1080, 1080, 1920, 1080)).toEqual({
      x: 420,
      y: 0,
      width: 1080,
      height: 1080
    });
  });

  it("letterboxes a wider frame", () => {
    expect(letterbox(2560, 1080, 1920, 1080)).toEqual({
      x: 0,
      y: 135,
      width: 1920,
      height: 810
    });
  });
});
