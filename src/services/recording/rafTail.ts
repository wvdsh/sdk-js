import type { FrameWindow } from "../../utils/sameOriginFrames";

export type TailListener = (
  win: FrameWindow,
  timestamp: number,
  gameRan: boolean
) => void;

interface WindowTail {
  start: () => void;
  stop: () => void;
  uninstall: () => void;
}

export class RafTail {
  private tails = new Map<FrameWindow, WindowTail>();
  private listener: TailListener | null = null;

  attach(win: FrameWindow): void {
    if (this.tails.has(win)) return;
    const original = win.requestAnimationFrame;
    const nativeRaf = original.bind(win);
    const nativeCancel = win.cancelAnimationFrame.bind(win);
    let handle = 0;
    let pending = false;
    let frameActive = false;
    let active = false;
    const tail = (timestamp: number): void => {
      pending = false;
      const gameRan = frameActive;
      frameActive = false;
      if (!active) return;
      handle = nativeRaf(tail);
      pending = true;
      this.listener!(win, timestamp, gameRan);
    };
    const wrapped = (callback: FrameRequestCallback): number => {
      if (!active) return nativeRaf(callback);
      const id = nativeRaf((timestamp) => {
        frameActive = true;
        callback(timestamp);
      });
      if (pending && !frameActive) {
        nativeCancel(handle);
        handle = nativeRaf(tail);
      }
      return id;
    };
    win.requestAnimationFrame = wrapped;
    this.tails.set(win, {
      start: () => {
        active = true;
        if (pending) return;
        handle = nativeRaf(tail);
        pending = true;
      },
      stop: () => {
        active = false;
        frameActive = false;
        if (pending) nativeCancel(handle);
        pending = false;
      },
      uninstall: () => {
        if (pending) nativeCancel(handle);
        pending = false;
        active = false;
        if (win.requestAnimationFrame === wrapped) {
          win.requestAnimationFrame = original;
        }
      }
    });
  }

  detach(win: FrameWindow): void {
    this.tails.get(win)?.uninstall();
    this.tails.delete(win);
  }

  start(windows: Iterable<FrameWindow>, listener: TailListener): void {
    if (this.listener) throw new Error("RafTail already running");
    this.listener = listener;
    for (const win of windows) {
      const tail = this.tails.get(win);
      if (!tail) throw new Error("RafTail has no hook for a capture window");
      tail.start();
    }
  }

  stop(): void {
    this.tails.forEach((tail) => tail.stop());
    this.listener = null;
  }

  destroy(): void {
    this.tails.forEach((tail) => tail.uninstall());
    this.tails.clear();
    this.listener = null;
  }
}
