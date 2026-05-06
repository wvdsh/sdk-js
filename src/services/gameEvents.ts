import type { WavedashSDK } from "../index";
import type { WavedashEvent } from "../types";
import { WavedashManager } from "./manager";

interface QueuedEvent {
  event: WavedashEvent;
  payload: string | number | object;
}

export class GameEventManager extends WavedashManager {
  private eventQueue: QueuedEvent[] = [];

  constructor(sdk: WavedashSDK) {
    super(sdk);
  }

  // ==============================
  // JS -> Game Event Broadcasting
  // ==============================
  notifyGame(event: WavedashEvent, payload: string | number | object): void {
    if (!this.sdk.eventsReady) {
      this.eventQueue.push({ event, payload });
      this.sdk.logger.debug(`Queued event: ${event}`);
      return;
    }

    if (!this.sdk.engineInstance) {
      this.sdk.dispatchEvent(new CustomEvent(event, { detail: payload }));
    } else {
      this.sendGameEvent(event, payload);
    }
  }

  private sendGameEvent(
    event: WavedashEvent,
    payload: string | number | object
  ): void {
    const data =
      typeof payload === "object" ? JSON.stringify(payload) : payload;
    if (this.sdk.engineInstance?.SendMessage) {
      this.sdk.engineInstance.SendMessage(
        this.sdk.engineCallbackReceiver,
        event,
        data
      );
    } else {
      this.sdk.logger.error("Engine instance not set. Dropping event:", event);
    }
  }

  flushEventQueue(): void {
    const toFlush = this.eventQueue;
    this.eventQueue = [];
    for (const queuedEvent of toFlush) {
      this.notifyGame(queuedEvent.event, queuedEvent.payload);
    }
  }
}
