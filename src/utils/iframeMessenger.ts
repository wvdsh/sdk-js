/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import { IFRAME_MESSAGE_TYPE, IFrameEventPayloadMap } from "@wvdsh/api";
import { getParentOrigin } from "./parentOrigin";

const RESPONSE_TIMEOUT_MS = 15_000;

// Track pending requests - response can be any value from IFrameResponseMap
type IFrameResponseValue = IFrameEventPayloadMap[keyof IFrameEventPayloadMap];

type PendingRequest = {
  resolve: (data: IFrameResponseValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PushType = keyof IFrameEventPayloadMap;
type PushListener<T extends PushType> = (
  data: IFrameEventPayloadMap[T]
) => void;

export class IFrameMessenger {
  private pendingRequests: Map<string, PendingRequest>;
  private requestIdCounter: number;
  private listeners: Map<PushType, Set<PushListener<PushType>>>;

  constructor() {
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.listeners = new Map();

    // Initialize the persistent message listener
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.handleMessage);
    }
  }

  /**
   * Register a handler for a one-way (no requestId) push from the parent —
   * e.g. FULLSCREEN_CHANGED or TAKE_FOCUS. Multiple handlers per type are
   * supported; `data` is typed from IFramePushMap.
   */
  addEventListener<T extends PushType>(
    type: T,
    listener: PushListener<T>
  ): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as PushListener<PushType>);
  }

  removeEventListener<T extends PushType>(
    type: T,
    listener: PushListener<T>
  ): void {
    this.listeners.get(type)?.delete(listener as PushListener<PushType>);
  }

  // Arrow function automatically captures 'this' from the class instance
  private handleMessage = (event: MessageEvent): void => {
    // Validate origin to prevent JWT spoofing and other attacks.
    // Skip messages from our own window (e.g. js-dos sleep-sync postMessage traffic).
    if (event.origin !== getParentOrigin()) {
      if (event.source !== window) {
        console.warn(`Ignored message from untrusted origin: ${event.origin}`);
      }
      return;
    }

    if (event.data?.requestId) {
      const pending = this.pendingRequests.get(event.data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(event.data.requestId);
        pending.resolve(event.data.data);
      }
      return;
    }

    const messageType = event.data?.type as PushType | undefined;
    if (!messageType) return;

    const set = this.listeners.get(messageType);
    if (!set) return;
    for (const listener of set) listener(event.data);
  };

  postToParent(
    requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
    data: Record<string, string | number | boolean>
  ): boolean {
    const parentOrigin = getParentOrigin();
    if (typeof window === "undefined" || !parentOrigin) return false;
    window.parent.postMessage({ type: requestType, ...data }, parentOrigin);
    return true;
  }

  async requestFromParent<T extends keyof IFrameEventPayloadMap>(
    requestType: T,
    data?: Record<string, unknown>,
    timeoutMs: number = RESPONSE_TIMEOUT_MS
  ): Promise<IFrameEventPayloadMap[T]> {
    return new Promise((resolve, reject) => {
      const parentOrigin = getParentOrigin();
      if (typeof window === "undefined" || !parentOrigin) {
        reject(new Error("Parent origin not found"));
        return;
      }

      const requestId = `${requestType}_${++this.requestIdCounter}_${Date.now()}`;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `${requestType} request timed out after ${timeoutMs}ms`
          )
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (data: IFrameResponseValue) => void,
        reject,
        timeout
      });

      window.parent.postMessage(
        { type: requestType, requestId, ...data },
        parentOrigin
      );
    });
  }
}
