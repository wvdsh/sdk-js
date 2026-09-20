import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioManager } from "../src/services/audio";
import { WavedashEvents } from "../src/events";
import { IFRAME_MESSAGE_TYPE } from "../src/utils/iframeMessages";
import { IFrameMessenger } from "../src/utils/iframeMessenger";
import { setParentOrigin } from "../src/utils/parentOrigin";
import type { WavedashSDK } from "../src/index";

class TestAudioContext {
  currentTime = 10;
  destination = { maxChannelCount: 2 };
  createGain() {
    const gain = {
      value: 1,
      cancelAndHoldAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn()
    };
    return { gain, connect: vi.fn() };
  }
  createMediaElementSource() {
    return { connect: vi.fn() };
  }
  close() {
    return Promise.resolve();
  }
}

let manager: AudioManager;
let messenger: IFrameMessenger;
let notifyGame: ReturnType<typeof vi.fn>;
let nativeVolume: PropertyDescriptor;
let nativeMuted: PropertyDescriptor;
const origin = "https://wavedash.lvh.me";

function push(type: string, data: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", { origin, data: { type, ...data } })
  );
}

beforeEach(() => {
  document.body.replaceChildren();
  nativeVolume = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "volume"
  )!;
  nativeMuted = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "muted"
  )!;
  vi.stubGlobal("AudioContext", TestAudioContext);
  vi.stubGlobal("AudioNode", class {});
  setParentOrigin(origin);
  messenger = new IFrameMessenger();
  notifyGame = vi.fn();
  manager = new AudioManager({
    iframeMessenger: messenger,
    gameEventManager: { notifyGame }
  } as unknown as WavedashSDK);
});

afterEach(() => {
  manager.destroy();
  window.removeEventListener(
    "message",
    (messenger as unknown as { handleMessage: EventListener }).handleMessage
  );
  setParentOrigin("");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("volume requests", () => {
  it.each([0, 0.35, 1])(
    "sends %s through the iframe protocol and waits for host state",
    async (volume) => {
      const post = vi
        .spyOn(window.parent, "postMessage")
        .mockImplementation((message) => {
          expect(message).toMatchObject({ type: "SetVolume", volume });
          window.dispatchEvent(
            new MessageEvent("message", {
              origin,
              data: { requestId: message.requestId, data: { success: true } }
            })
          );
        });
      await expect(manager.requestVolume(volume)).resolves.toBe(true);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({ volume }),
        origin
      );
      expect(manager.getVolume()).toBe(1);
      push("VolumeChanged", { volume });
      expect(manager.getVolume()).toBe(volume);
      expect(manager.isMuted()).toBe(volume === 0);
    }
  );

  it.each([-1, 1.01, 35, NaN, Infinity, -Infinity, "0.5", null, undefined])(
    "rejects invalid input %s without contacting the host",
    async (volume) => {
      const request = vi.spyOn(messenger, "requestFromParent");
      await expect(manager.requestVolume(volume as number)).rejects.toThrow(
        RangeError
      );
      expect(request).not.toHaveBeenCalled();
    }
  );

  it("keeps state unchanged when the host rejects increasing a player mute", async () => {
    push("MuteChanged", { isMuted: true });
    vi.spyOn(messenger, "requestFromParent").mockResolvedValue({
      success: false
    });
    await expect(manager.requestVolume(0.5)).resolves.toBe(false);
    expect(manager.isMuted()).toBe(true);
    expect(manager.getVolume()).toBe(0);
  });

  it("returns false without a parent", async () => {
    setParentOrigin("");
    const request = vi.spyOn(messenger, "requestFromParent");
    await expect(manager.requestVolume(0.5)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps legacy mute and toggle request messages unchanged", async () => {
    const request = vi
      .spyOn(messenger, "requestFromParent")
      .mockResolvedValue({ success: true });
    await manager.requestMute(true);
    expect(request).toHaveBeenLastCalledWith(IFRAME_MESSAGE_TYPE.SET_MUTE, {
      muted: true
    });
    await manager.requestMute(false);
    expect(request).toHaveBeenLastCalledWith(IFRAME_MESSAGE_TYPE.SET_MUTE, {
      muted: false
    });
    await manager.toggleMute();
    expect(request).toHaveBeenLastCalledWith(IFRAME_MESSAGE_TYPE.TOGGLE_MUTE);
  });

  it("propagates unsupported-host timeouts without changing volume", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
      const result = expect(manager.requestVolume(0.5)).rejects.toThrow(
        "SetVolume request timed out"
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await result;
      expect(manager.getVolume()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("audio scaling", () => {
  it("ramps existing Web Audio contexts and initializes new ones at the current volume", () => {
    const context = new AudioContext();
    const gain = (context.destination as unknown as GainNode).gain;
    push("VolumeChanged", { volume: 0.35 });
    expect(gain.cancelAndHoldAtTime).toHaveBeenCalledWith(10);
    expect(gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.35, 10.05);
    const next = new AudioContext();
    expect((next.destination as unknown as GainNode).gain.value).toBe(0.35);
  });

  it("preserves HTML media volume and independent mute settings", () => {
    const audio = new Audio();
    audio.volume = 0.8;
    audio.muted = true;
    push("VolumeChanged", { volume: 0.25 });
    expect(audio.volume).toBe(0.8);
    expect(nativeVolume.get!.call(audio)).toBeCloseTo(0.2);
    expect(nativeMuted.get!.call(audio)).toBe(true);
    audio.volume = 0.4;
    expect(nativeVolume.get!.call(audio)).toBeCloseTo(0.1);
    push("MuteChanged", { isMuted: true });
    expect(nativeVolume.get!.call(audio)).toBe(0);
    push("MuteChanged", { isMuted: false });
    expect(nativeVolume.get!.call(audio)).toBeCloseTo(0.1);
    expect(audio.volume).toBe(0.4);
    expect(nativeMuted.get!.call(audio)).toBe(true);
    expect(manager.getVolume()).toBe(0.25);
  });

  it("applies volume to newly created and off-DOM media", async () => {
    push("VolumeChanged", { volume: 0.5 });
    const audio = new Audio();
    expect(nativeVolume.get!.call(audio)).toBe(0.5);
    const detached = document.createElement("audio");
    await detached.play();
    expect(nativeVolume.get!.call(detached)).toBe(0.5);
    const video = document.createElement("video");
    video.volume = 0.6;
    expect(nativeVolume.get!.call(video)).toBeCloseTo(0.3);
  });

  it("does not attenuate media twice when it is routed through Web Audio", () => {
    push("VolumeChanged", { volume: 0.5 });
    const audio = new Audio();
    audio.volume = 0.8;
    const context = new AudioContext();
    context.createMediaElementSource(audio).connect(context.destination);
    expect(nativeVolume.get!.call(audio)).toBe(0.8);
    expect((context.destination as unknown as GainNode).gain.value).toBe(0.5);
    audio.volume = 0.6;
    push("VolumeChanged", { volume: 0.25 });
    expect(nativeVolume.get!.call(audio)).toBe(0.6);
  });

  it("restores the previous volume after a zero-volume mute", () => {
    push("VolumeChanged", { volume: 0.35 });
    push("VolumeChanged", { volume: 0 });
    expect(manager.isMuted()).toBe(true);
    push("MuteChanged", { isMuted: false });
    expect(manager.getVolume()).toBe(0.35);
  });

  it("emits changes once, ignores invalid values, and retains legacy mute events", () => {
    push("VolumeChanged", { volume: 0.5 });
    push("VolumeChanged", { volume: 0.5 });
    push("VolumeChanged", { volume: -1 });
    push("VolumeChanged", { volume: 2 });
    expect(notifyGame).toHaveBeenCalledTimes(1);
    expect(notifyGame).toHaveBeenLastCalledWith(WavedashEvents.VOLUME_CHANGED, {
      volume: 0.5
    });
    push("VolumeChanged", { volume: 0 });
    expect(notifyGame).toHaveBeenCalledWith(WavedashEvents.MUTE_CHANGED, {
      isMuted: true
    });
    expect(notifyGame).toHaveBeenLastCalledWith(WavedashEvents.VOLUME_CHANGED, {
      volume: 0
    });
  });

  it("restores media volume and descriptors and stops responding after teardown", () => {
    const audio = new Audio();
    audio.volume = 0.8;
    push("VolumeChanged", { volume: 0.5 });
    manager.destroy();
    expect(audio.volume).toBe(0.8);
    expect(
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")
    ).toEqual(nativeVolume);
    push("VolumeChanged", { volume: 0.1 });
    expect(audio.volume).toBe(0.8);
    expect(manager.getVolume()).toBe(0.5);
  });
});
