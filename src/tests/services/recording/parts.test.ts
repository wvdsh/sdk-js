import { describe, expect, it } from "vitest";
import { PART_SIZE, PartChunker } from "../../../services/recording/parts";

function bytes(length: number, start = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (start + i) % 251);
}

describe("PartChunker", () => {
  it("uses 8 MiB parts by default", () => {
    expect(PART_SIZE).toBe(8 * 1024 * 1024);
  });

  it("emits exactly sized parts and a remainder, preserving bytes", () => {
    const parts: ArrayBuffer[] = [];
    const chunker = new PartChunker((part) => parts.push(part), 10);
    let position = 0;
    for (const size of [3, 4, 9, 1, 15, 2]) {
      chunker.write(bytes(size, position), position);
      position += size;
    }
    const remainder = chunker.finish();
    expect(parts.map((part) => part.byteLength)).toEqual([10, 10, 10]);
    expect(remainder.byteLength).toBe(4);
    const joined = new Uint8Array(34);
    let offset = 0;
    for (const chunk of [...parts, remainder]) {
      joined.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    expect(joined).toEqual(bytes(34));
  });

  it("emits an empty remainder when writes end on a part boundary", () => {
    const parts: ArrayBuffer[] = [];
    const chunker = new PartChunker((part) => parts.push(part), 8);
    chunker.write(bytes(16));
    expect(parts).toHaveLength(2);
    expect(chunker.finish().byteLength).toBe(0);
  });

  it("does not reuse buffers handed out as parts", () => {
    const parts: ArrayBuffer[] = [];
    const chunker = new PartChunker((part) => parts.push(part), 4);
    chunker.write(bytes(4, 0));
    chunker.write(bytes(4, 100));
    expect(Array.from(new Uint8Array(parts[0]))).toEqual([0, 1, 2, 3]);
    expect(Array.from(new Uint8Array(parts[1]))).toEqual([100, 101, 102, 103]);
  });

  it("rejects non-sequential writes and writes after finish", () => {
    const chunker = new PartChunker(() => {}, 4);
    chunker.write(bytes(2), 0);
    expect(() => chunker.write(bytes(2), 5)).toThrow(/Non-sequential/);
    chunker.finish();
    expect(() => chunker.write(bytes(1))).toThrow(/after finish/);
    expect(() => chunker.finish()).toThrow(/twice/);
  });
});
