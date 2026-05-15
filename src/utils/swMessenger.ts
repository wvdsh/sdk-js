/**
 * Utilities for messaging between the SDK and the service worker
 * that proxies API requests on its behalf.
 */

import { logger } from "./logger";

export type SwMessage<T = unknown> = {
  type: string;
  payload?: T;
};

export type SwReply = (message: SwMessage) => void;

type SwListener = (payload: unknown, reply: SwReply) => void;

export class SwMessenger {
  private listeners: Map<string, Set<SwListener>>;

  constructor() {
    this.listeners = new Map();

    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", this.handleMessage);
    }
  }

  /**
   * Register a handler for an incoming message type from the SW. The handler
   * receives the message payload and a `reply` function that routes the
   * response back via the transferred MessagePort when present, falling back
   * to a controller postMessage otherwise.
   */
  addEventListener(type: string, listener: SwListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: SwListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /**
   * Fire-and-forget message to the active service worker controller. No-op
   * when no SW is controlling the page (first load before activation, or
   * environments without SW support).
   */
  postToServiceWorker(message: SwMessage): boolean {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) {
      return false;
    }
    try {
      navigator.serviceWorker.controller?.postMessage(message);
      return true;
    } catch (err) {
      logger.warn("Failed to post message to service worker", err);
      return false;
    }
  }

  private handleMessage = (event: MessageEvent): void => {
    const data = event.data as SwMessage | undefined;
    const type = data?.type;
    if (!type) return;

    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;

    const port = event.ports?.[0];
    const reply: SwReply = (message) => {
      if (port) {
        try {
          port.postMessage(message);
          return;
        } catch (err) {
          logger.warn("Failed to reply to SW via port", err);
        }
      }
      this.postToServiceWorker(message);
    };

    for (const listener of set) listener(data?.payload, reply);
  };
}
