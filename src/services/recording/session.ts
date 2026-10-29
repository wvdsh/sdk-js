import {
  IFRAME_MESSAGE_TYPE,
  type IFrameEventPayloadMap,
  type RecordingFailureReason,
  type RecordingFile
} from "@wvdsh/api";
import { PART_SIZE } from "./parts";

type OutboundType =
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_STARTED
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_DATA
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_FINISHED
  | typeof IFRAME_MESSAGE_TYPE.RECORDING_FAILED;

export type RecordingPost = <T extends OutboundType>(
  type: T,
  payload: IFrameEventPayloadMap[T],
  transfer?: Transferable[]
) => void;

type FinishedPayload = Omit<
  IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.RECORDING_FINISHED],
  "recordingId"
>;

type State = "pending" | "live" | "finished" | "failed";

export class RecordingSession {
  private state: State = "pending";
  private trackCount = 0;
  private hasDom = false;
  private finalized = new Set<RecordingFile>();

  constructor(
    readonly recordingId: number,
    private readonly post: RecordingPost
  ) {}

  get isOpen(): boolean {
    return this.state === "pending" || this.state === "live";
  }

  started(trackCount: number, hasDom: boolean): void {
    this.expect("pending");
    if (!Number.isInteger(trackCount) || trackCount < 1) {
      throw new Error(`Invalid trackCount ${trackCount}`);
    }
    this.trackCount = trackCount;
    this.hasDom = hasDom;
    this.state = "live";
    this.post(IFRAME_MESSAGE_TYPE.RECORDING_STARTED, {
      recordingId: this.recordingId,
      trackCount,
      hasDom
    });
  }

  data(file: RecordingFile, data: ArrayBuffer, final: boolean): void {
    this.expect("live");
    if (this.finalized.has(file)) {
      throw new Error(`${file} already finalized`);
    }
    const track = /^(\d+)\.mp4$/.exec(file);
    if (track) {
      if (Number(track[1]) >= this.trackCount) {
        throw new Error(`${file} exceeds trackCount ${this.trackCount}`);
      }
      if (!final && data.byteLength !== PART_SIZE) {
        throw new Error(
          `${file} part is ${data.byteLength} bytes, expected ${PART_SIZE}`
        );
      }
    } else {
      if (!final) throw new Error(`${file} must be sent in one final message`);
      if (file === "dom.json.gz" && !this.hasDom) {
        throw new Error("dom.json.gz sent for a recording without DOM");
      }
    }
    if (final) this.finalized.add(file);
    this.post(
      IFRAME_MESSAGE_TYPE.RECORDING_DATA,
      { recordingId: this.recordingId, file, data, final },
      [data]
    );
  }

  finished(payload: FinishedPayload): void {
    this.expect("live");
    const missing = this.requiredFiles().filter(
      (file) => !this.finalized.has(file)
    );
    if (missing.length) {
      throw new Error(`Finished before final data for ${missing.join(", ")}`);
    }
    this.state = "finished";
    this.post(IFRAME_MESSAGE_TYPE.RECORDING_FINISHED, {
      recordingId: this.recordingId,
      ...payload
    });
  }

  failed(error: string, reason?: RecordingFailureReason): void {
    if (!this.isOpen) return;
    this.state = "failed";
    this.post(IFRAME_MESSAGE_TYPE.RECORDING_FAILED, {
      recordingId: this.recordingId,
      error,
      ...(reason && { reason })
    });
  }

  private requiredFiles(): RecordingFile[] {
    const files: RecordingFile[] = Array.from(
      { length: this.trackCount },
      (_, index) => `${index}.mp4` as const
    );
    if (this.hasDom) files.push("dom.json.gz");
    files.push("manifest.json");
    return files;
  }

  private expect(state: State): void {
    if (this.state !== state) {
      throw new Error(
        `Recording ${this.recordingId} is ${this.state}, expected ${state}`
      );
    }
  }
}
