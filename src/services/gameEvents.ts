import type { WavedashSDK } from "../index";
import type { WavedashEvent } from "../types";

interface QueuedEvent {
  event: WavedashEvent;
  payload: string | number | boolean | object;
}

export class GameEventManager {
  private sdk: WavedashSDK;
  private eventQueue: QueuedEvent[] = [];

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ==============================
  // JS -> Game Event Broadcasting
  // ==============================
  notifyGame(
    event: WavedashEvent,
    payload: string | number | boolean | object
  ): void {
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
    payload: string | number | boolean | object
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
