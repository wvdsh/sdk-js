import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { describe, expect, it } from "vitest";
import { PART_SIZE } from "../../../services/recording/parts";
import {
  RecordingSession,
  type RecordingPost
} from "../../../services/recording/session";

function setup(recordingId = 7) {
  const posted: {
    type: string;
    payload: Record<string, unknown>;
    transfer?: Transferable[];
  }[] = [];
  const post: RecordingPost = (type, payload, transfer) => {
    posted.push({
      type,
      payload: payload as Record<string, unknown>,
      transfer
    });
  };
  return { session: new RecordingSession(recordingId, post), posted };
}

const poster = new Blob(["poster"], { type: "image/webp" });
const part = () => new ArrayBuffer(PART_SIZE);

describe("RecordingSession", () => {
  it("posts a full canvas-only recording in protocol order", () => {
    const { session, posted } = setup();
    session.started(1, false);
    const first = part();
    session.data("0.mp4", first, false);
    session.data("0.mp4", new ArrayBuffer(123), true);
    session.data("manifest.json", new ArrayBuffer(10), true);
    session.finished({ durationMs: 1000, width: 1280, height: 720, poster });
    expect(
      posted.map((m) => [m.type, m.payload.file, m.payload.final])
    ).toEqual([
      [IFRAME_MESSAGE_TYPE.RECORDING_STARTED, undefined, undefined],
      [IFRAME_MESSAGE_TYPE.RECORDING_DATA, "0.mp4", false],
      [IFRAME_MESSAGE_TYPE.RECORDING_DATA, "0.mp4", true],
      [IFRAME_MESSAGE_TYPE.RECORDING_DATA, "manifest.json", true],
      [IFRAME_MESSAGE_TYPE.RECORDING_FINISHED, undefined, undefined]
    ]);
    expect(posted.every((m) => m.payload.recordingId === 7)).toBe(true);
    expect(posted[0].payload).toMatchObject({ trackCount: 1, hasDom: false });
    expect(posted[1].transfer).toEqual([first]);
    expect(posted[4].payload).toMatchObject({ durationMs: 1000, poster });
  });

  it("allows an empty final part", () => {
    const { session } = setup();
    session.started(1, false);
    expect(() => session.data("0.mp4", new ArrayBuffer(0), true)).not.toThrow();
  });

  it("rejects non-final track parts that are not exactly 8 MiB", () => {
    const { session } = setup();
    session.started(1, false);
    expect(() =>
      session.data("0.mp4", new ArrayBuffer(PART_SIZE - 1), false)
    ).toThrow(/expected/);
  });

  it("rejects data before start, after a file's final, and for unknown tracks", () => {
    const { session } = setup();
    expect(() => session.data("0.mp4", part(), false)).toThrow(/pending/);
    session.started(2, false);
    expect(() => session.data("2.mp4", part(), false)).toThrow(/trackCount/);
    session.data("1.mp4", new ArrayBuffer(1), true);
    expect(() => session.data("1.mp4", part(), false)).toThrow(/finalized/);
  });

  it("requires dom.json.gz only when the recording has DOM", () => {
    const withoutDom = setup().session;
    withoutDom.started(1, false);
    expect(() =>
      withoutDom.data("dom.json.gz", new ArrayBuffer(1), true)
    ).toThrow(/without DOM/);

    const withDom = setup().session;
    withDom.started(1, true);
    withDom.data("0.mp4", new ArrayBuffer(1), true);
    withDom.data("manifest.json", new ArrayBuffer(1), true);
    expect(() =>
      withDom.finished({ durationMs: 1, width: 2, height: 2, poster })
    ).toThrow(/dom.json.gz/);
  });

  it("refuses to finish before every track is final", () => {
    const { session } = setup();
    session.started(2, false);
    session.data("0.mp4", new ArrayBuffer(1), true);
    session.data("manifest.json", new ArrayBuffer(1), true);
    expect(() =>
      session.finished({ durationMs: 1, width: 2, height: 2, poster })
    ).toThrow(/1.mp4/);
  });

  it("posts failure once and goes quiet", () => {
    const { session, posted } = setup();
    session.started(1, false);
    session.failed("boom");
    session.failed("again", "no-canvas");
    expect(
      posted.filter((m) => m.type === IFRAME_MESSAGE_TYPE.RECORDING_FAILED)
    ).toEqual([
      {
        type: IFRAME_MESSAGE_TYPE.RECORDING_FAILED,
        payload: { recordingId: 7, error: "boom" },
        transfer: undefined
      }
    ]);
    expect(session.isOpen).toBe(false);
    expect(() => session.data("0.mp4", part(), false)).toThrow(/failed/);
  });

  it("can fail before start with a reason", () => {
    const { session, posted } = setup(3);
    session.failed("No game canvas found.", "no-canvas");
    expect(posted).toEqual([
      {
        type: IFRAME_MESSAGE_TYPE.RECORDING_FAILED,
        payload: {
          recordingId: 3,
          error: "No game canvas found.",
          reason: "no-canvas"
        },
        transfer: undefined
      }
    ]);
  });

  it("does not fail after finishing", () => {
    const { session, posted } = setup();
    session.started(1, false);
    session.data("0.mp4", new ArrayBuffer(0), true);
    session.data("manifest.json", new ArrayBuffer(1), true);
    session.finished({ durationMs: 1, width: 2, height: 2, poster });
    session.failed("late");
    expect(posted.at(-1)!.type).toBe(IFRAME_MESSAGE_TYPE.RECORDING_FINISHED);
  });
});
