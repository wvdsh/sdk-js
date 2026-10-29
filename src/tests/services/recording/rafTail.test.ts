import { describe, expect, it } from "vitest";
import { RafTail } from "../../../services/recording/rafTail";
import type { FrameWindow } from "../../../utils/sameOriginFrames";

function fakeWindow() {
  let nextId = 1;
  let queue = new Map<number, FrameRequestCallback>();
  let current = new Map<number, FrameRequestCallback>();
  const win = {
    requestAnimationFrame(callback: FrameRequestCallback): number {
      const id = nextId++;
      queue.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number): void {
      queue.delete(id);
      current.delete(id);
    }
  };
  return {
    win: win as unknown as FrameWindow,
    frame(timestamp: number): void {
      current = queue;
      queue = new Map();
      for (const id of Array.from(current.keys())) {
        const callback = current.get(id);
        if (!callback) continue;
        current.delete(id);
        callback(timestamp);
      }
    }
  };
}

describe("RafTail", () => {
  it("runs the tail after the game's callback in every frame", () => {
    const fake = fakeWindow();
    const tail = new RafTail();
    tail.attach(fake.win);
    const order: string[] = [];
    const game = (timestamp: number): void => {
      order.push(`game@${timestamp}`);
      fake.win.requestAnimationFrame(game);
    };
    fake.win.requestAnimationFrame(game);
    tail.start([fake.win], (_win, timestamp, gameRan) =>
      order.push(`tail@${timestamp}:${gameRan}`)
    );
    fake.frame(1);
    fake.frame(2);
    fake.frame(3);
    expect(order).toEqual([
      "game@1",
      "game@2",
      "tail@2:true",
      "game@3",
      "tail@3:true"
    ]);
  });

  it("keeps the tail last when the game registers between frames", () => {
    const fake = fakeWindow();
    const tail = new RafTail();
    tail.attach(fake.win);
    const order: string[] = [];
    tail.start([fake.win], (_win, timestamp, gameRan) =>
      order.push(`tail@${timestamp}:${gameRan}`)
    );
    fake.win.requestAnimationFrame((t) => order.push(`timer-scheduled@${t}`));
    fake.frame(1);
    expect(order).toEqual(["timer-scheduled@1", "tail@1:true"]);
  });

  it("reports frames without game work, e.g. timer-driven games", () => {
    const fake = fakeWindow();
    const tail = new RafTail();
    tail.attach(fake.win);
    const seen: boolean[] = [];
    tail.start([fake.win], (_win, _timestamp, gameRan) => seen.push(gameRan));
    fake.frame(1);
    fake.frame(2);
    expect(seen).toEqual([false, false]);
  });

  it("passes through untouched when idle and restores on uninstall", () => {
    const fake = fakeWindow();
    const original = fake.win.requestAnimationFrame;
    const tail = new RafTail();
    tail.attach(fake.win);
    expect(fake.win.requestAnimationFrame).not.toBe(original);
    const ran: number[] = [];
    fake.win.requestAnimationFrame((t) => ran.push(t));
    fake.frame(7);
    expect(ran).toEqual([7]);
    tail.destroy();
    expect(fake.win.requestAnimationFrame).toBe(original);
  });
});
