export const PART_SIZE = 8 * 1024 * 1024;

export class PartChunker {
  private buffer: Uint8Array;
  private filled = 0;
  private written = 0;
  private finished = false;

  constructor(
    private readonly onPart: (part: ArrayBuffer) => void,
    private readonly partSize: number = PART_SIZE
  ) {
    this.buffer = new Uint8Array(partSize);
  }

  get bytesWritten(): number {
    return this.written;
  }

  write(data: Uint8Array, position: number = this.written): void {
    if (this.finished) throw new Error("PartChunker written after finish");
    if (position !== this.written) {
      throw new Error(
        `Non-sequential write at ${position}, expected ${this.written}`
      );
    }
    let offset = 0;
    while (offset < data.byteLength) {
      const count = Math.min(
        this.partSize - this.filled,
        data.byteLength - offset
      );
      this.buffer.set(data.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.partSize) {
        const part = this.buffer.buffer as ArrayBuffer;
        this.buffer = new Uint8Array(this.partSize);
        this.filled = 0;
        this.onPart(part);
      }
    }
    this.written += data.byteLength;
  }

  finish(): ArrayBuffer {
    if (this.finished) throw new Error("PartChunker finished twice");
    this.finished = true;
    return this.buffer.slice(0, this.filled).buffer as ArrayBuffer;
  }
}
