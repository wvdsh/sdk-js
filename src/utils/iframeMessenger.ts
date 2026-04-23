/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import {
  IFRAME_MESSAGE_TYPE,
  IFramePushMap,
  IFrameResponseMap
} from "@wvdsh/types";
import { parentOrigin } from "./parentOrigin";

const RESPONSE_TIMEOUT_MS = 15_000;

// Track pending requests - response can be any value from IFrameResponseMap
type IFrameResponseValue = IFrameResponseMap[keyof IFrameResponseMap];

type PendingRequest = {
  resolve: (data: IFrameResponseValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PushType = keyof IFramePushMap;
type PushListener<T extends PushType> = (data: IFramePushMap[T]) => void;

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
  addEventListener<T extends PushType>(type: T, listener: PushListener<T>): void {
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
    if (event.origin !== parentOrigin) {
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

    console.log("[wvdsh-sdk] iframe push from parent:", messageType, event.data);

    const set = this.listeners.get(messageType);
    if (!set) return;
    for (const listener of set) listener(event.data);
  };

  postToParent(
    requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
    data: Record<string, string | number | boolean>
  ): boolean {
    if (typeof window === "undefined" || !parentOrigin) return false;
    console.log("[wvdsh-sdk] iframe post to parent:", requestType, data);
    window.parent.postMessage({ type: requestType, ...data }, parentOrigin);
    return true;
  }

  /**
   * Register global keyboard/mouse handlers for iframe communication.
   * Handles F3 prevention, initial interaction signaling, and Tab+Shift overlay toggle.
   * Called once during SDK setup.
   */
  registerEventHandlers() {
    let sentInitialInteraction = false;

    const handleInteraction = () => {
      if (!sentInitialInteraction) {
        sentInitialInteraction = true;
        this.postToParent(IFRAME_MESSAGE_TYPE.INITIAL_INTERACTION, {});
      }
    };

    window.addEventListener("keydown", (event) => {
      if (event.key === "F3") {
        event.preventDefault();
      }

      handleInteraction();

      if (event.key === "Tab" && event.shiftKey) {
        event.preventDefault();
        this.postToParent(IFRAME_MESSAGE_TYPE.TOGGLE_OVERLAY, {});
      }
    });

    window.addEventListener("mousedown", handleInteraction);
  }

  async requestFromParent<T extends keyof IFrameResponseMap>(
    requestType: T,
    data?: Record<string, unknown>
  ): Promise<IFrameResponseMap[T]> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !parentOrigin) {
        reject(new Error("Parent origin not found"));
        return;
      }

      const requestId = `${requestType}_${++this.requestIdCounter}_${Date.now()}`;

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(
          new Error(
            `${requestType} request timed out after ${RESPONSE_TIMEOUT_MS}ms`
          )
        );
      }, RESPONSE_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (responseData) => {
          console.log(
            "[wvdsh-sdk] iframe response from parent:",
            requestType,
            responseData
          );
          (resolve as (d: IFrameResponseValue) => void)(responseData);
        },
        reject,
        timeout
      });

      console.log("[wvdsh-sdk] iframe request to parent:", requestType, data);
      window.parent.postMessage(
        { type: requestType, requestId, ...data },
        parentOrigin
      );
    });
  }
}
