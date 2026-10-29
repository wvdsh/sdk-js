import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WavedashSDK } from "../../index";
import {
  ScreenCaptureManager,
  type RecorderModule,
  type RecorderWindow
} from "../../services/screenCapture";

function setup() {
  const listeners = new Map<string, (data: unknown) => void>();
  const postToParent = vi.fn();
  const sdk = {
    iframeMessenger: {
      addEventListener: (type: string, listener: (data: unknown) => void) =>
        listeners.set(type, listener),
      removeEventListener: () => undefined,
      postToParent
    },
    sameOriginFrames: { subscribe: () => () => undefined },
    audioManager: { createCaptureTap: () => null }
  } as unknown as WavedashSDK;
  const record = (recordingId: number) =>
    listeners.get(IFRAME_MESSAGE_TYPE.RECORDING_CHANGED)!({
      isRecording: true,
      recordingId
    });
  return { sdk, record, postToParent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete (window as RecorderWindow).__wavedashRecorder;
});

describe("ScreenCaptureManager recorder loading", () => {
  it("reads the recorder global again after a failed load", async () => {
    const start = vi.fn();
    const module: RecorderModule = {
      createRecorder: () => ({ start, stop: vi.fn(), destroy: vi.fn() })
    };
    const target = window as RecorderWindow;
    target.__wavedashRecorder = Promise.reject(new Error("offline"));
    const { sdk, record, postToParent } = setup();
    new ScreenCaptureManager(sdk, undefined);
    record(1);
    await settle();
    expect(postToParent).toHaveBeenCalledWith(
      IFRAME_MESSAGE_TYPE.RECORDING_FAILED,
      { recordingId: 1, error: "Recorder unavailable: offline" }
    );
    target.__wavedashRecorder = Promise.resolve(module);
    record(2);
    await settle();
    expect(start).toHaveBeenCalledWith(2);
  });

  it("reports the recorder as unavailable when no global exists", async () => {
    const { sdk, record, postToParent } = setup();
    new ScreenCaptureManager(sdk, undefined);
    record(3);
    await settle();
    expect(postToParent).toHaveBeenCalledWith(
      IFRAME_MESSAGE_TYPE.RECORDING_FAILED,
      {
        recordingId: 3,
        error: "Recorder unavailable: no recorder in this environment"
      }
    );
  });
});
