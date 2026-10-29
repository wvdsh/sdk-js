export class VideoTimeline {
  private firstRaw: number | null = null;
  private firstArrivalUs = 0;
  private lastRaw: number | null = null;
  private arrivalMode = false;
  private last = -1;

  get usesArrivalTime(): boolean {
    return this.arrivalMode;
  }

  observe(rawUs: number): void {
    if (this.lastRaw !== null && rawUs <= this.lastRaw) this.arrivalMode = true;
    this.lastRaw = rawUs;
  }

  stamp(rawUs: number, arrivalUs: number): number {
    if (this.firstRaw === null) {
      this.firstRaw = rawUs;
      this.firstArrivalUs = arrivalUs;
    }
    let timestamp = this.arrivalMode
      ? Math.round(arrivalUs - this.firstArrivalUs)
      : rawUs - this.firstRaw;
    if (timestamp <= this.last) timestamp = this.last + 1;
    this.last = timestamp;
    return timestamp;
  }
}

export const MAX_AUDIO_LEAD_SECONDS = 1;

export class AudioTimeline {
  private written = 0;

  constructor(readonly sampleRate: number) {}

  get samplesWritten(): number {
    return this.written;
  }

  get timestampUs(): number {
    return Math.round((this.written * 1_000_000) / this.sampleRate);
  }

  private samplesAt(offsetUs: number): number {
    return Math.max(0, Math.round((offsetUs * this.sampleRate) / 1_000_000));
  }

  silenceUntil(offsetUs: number): number {
    return Math.max(0, this.samplesAt(offsetUs) - this.written);
  }

  placeBlock(
    arrivalOffsetUs: number,
    frames: number
  ): { silence: number; accept: boolean } {
    const start = this.samplesAt(arrivalOffsetUs) - frames;
    if (this.written - start > this.sampleRate * MAX_AUDIO_LEAD_SECONDS) {
      return { silence: 0, accept: false };
    }
    return { silence: Math.max(0, start - this.written), accept: true };
  }

  advance(frames: number): void {
    this.written += frames;
  }
}
