export class GzipJsonArrayWriter {
  private readonly writer: WritableStreamDefaultWriter<BufferSource>;
  private readonly result: Promise<ArrayBuffer>;
  private readonly encoder = new TextEncoder();
  private count = 0;
  private closed = false;
  private failure: unknown = null;

  constructor() {
    const stream = new CompressionStream("gzip");
    this.writer = stream.writable.getWriter();
    this.result = new Response(stream.readable).arrayBuffer();
    this.result.catch(() => undefined);
    this.write("[");
  }

  get length(): number {
    return this.count;
  }

  push(value: unknown): void {
    if (this.closed) throw new Error("GzipJsonArrayWriter is closed");
    this.write(`${this.count === 0 ? "" : ","}${JSON.stringify(value)}`);
    this.count++;
  }

  async finish(): Promise<ArrayBuffer> {
    if (this.closed) throw new Error("GzipJsonArrayWriter finished twice");
    this.closed = true;
    this.write("]");
    await this.writer.close();
    if (this.failure) throw this.failure;
    return this.result;
  }

  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.writer.abort().catch(() => undefined);
  }

  private write(text: string): void {
    this.writer.write(this.encoder.encode(text)).catch((error) => {
      this.failure ??= error;
    });
  }
}
