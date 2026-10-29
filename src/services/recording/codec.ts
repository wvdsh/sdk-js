const AVC_LEVELS: ReadonlyArray<
  readonly [level: number, maxFrameMbs: number, maxMbsPerSecond: number]
> = [
  [0x1e, 1620, 40500],
  [0x1f, 3600, 108000],
  [0x20, 5120, 216000],
  [0x28, 8192, 245760],
  [0x2a, 8704, 522240],
  [0x32, 22080, 589824],
  [0x33, 36864, 983040],
  [0x34, 36864, 2073600],
  [0x3c, 139264, 4177920],
  [0x3d, 139264, 8355840],
  [0x3e, 139264, 16711680]
];

export const ENCODE_LONG_EDGE = 1920;
export const ENCODE_SHORT_EDGE = 1080;
const BITRATE_AT_1080P = 10_000_000;
const MIN_BITRATE = 1_000_000;

export interface Size {
  width: number;
  height: number;
}

export function fitToEncodeBox(width: number, height: number): Size {
  if (width <= 0 || height <= 0) {
    throw new Error(`Cannot encode a ${width}x${height} source`);
  }
  const [boxWidth, boxHeight] =
    width >= height
      ? [ENCODE_LONG_EDGE, ENCODE_SHORT_EDGE]
      : [ENCODE_SHORT_EDGE, ENCODE_LONG_EDGE];
  const scale = Math.min(1, boxWidth / width, boxHeight / height);
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2)
  };
}

export function avcCodecString(width: number, height: number, fps: number) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const entry = AVC_LEVELS.find(
    ([, maxFrameMbs, maxMbsPerSecond]) =>
      frameMbs <= maxFrameMbs &&
      frameMbs * fps <= maxMbsPerSecond &&
      Math.max(width, height) <= Math.sqrt(8 * maxFrameMbs) * 16
  );
  if (!entry) {
    throw new Error(`No H.264 level fits ${width}x${height}@${fps}`);
  }
  return `avc1.6400${entry[0].toString(16).toUpperCase().padStart(2, "0")}`;
}

export function bitrateFor(width: number, height: number): number {
  return Math.round(
    Math.min(
      BITRATE_AT_1080P,
      Math.max(MIN_BITRATE, (BITRATE_AT_1080P * width * height) / (1920 * 1080))
    )
  );
}

const ES_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;

function readDescriptor(bytes: Uint8Array, offset: number) {
  const tag = bytes[offset];
  let length = 0;
  let cursor = offset + 1;
  for (let i = 0; i < 4; i++) {
    const byte = bytes[cursor++];
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { tag, start: cursor, end: cursor + length };
}

function findDecoderSpecificInfo(
  bytes: Uint8Array,
  start: number,
  end: number
): Uint8Array | null {
  let offset = start;
  while (offset < end) {
    const descriptor = readDescriptor(bytes, offset);
    if (descriptor.tag === DECODER_SPECIFIC_INFO_TAG) {
      return bytes.slice(descriptor.start, descriptor.end);
    }
    const childStart =
      descriptor.tag === ES_DESCRIPTOR_TAG
        ? descriptor.start + 3
        : descriptor.tag === DECODER_CONFIG_TAG
          ? descriptor.start + 13
          : null;
    if (childStart !== null) {
      const found = findDecoderSpecificInfo(bytes, childStart, descriptor.end);
      if (found) return found;
    }
    offset = descriptor.end;
  }
  return null;
}

export function audioSpecificConfig(description: Uint8Array): Uint8Array {
  if (description[0] !== ES_DESCRIPTOR_TAG) return description;
  const info = findDecoderSpecificInfo(description, 0, description.byteLength);
  if (!info) throw new Error("AAC esds description has no AudioSpecificConfig");
  return info;
}

const ASPECT_TOLERANCE = 0.01;

export interface Placement {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function letterbox(
  sourceWidth: number,
  sourceHeight: number,
  boxWidth: number,
  boxHeight: number
): Placement | null {
  const ratio = sourceWidth / sourceHeight / (boxWidth / boxHeight);
  if (Math.abs(ratio - 1) <= ASPECT_TOLERANCE) return null;
  const scale = Math.min(boxWidth / sourceWidth, boxHeight / sourceHeight);
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  return {
    x: Math.floor((boxWidth - width) / 2),
    y: Math.floor((boxHeight - height) / 2),
    width,
    height
  };
}
