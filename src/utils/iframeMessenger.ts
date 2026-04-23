/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import { IFRAME_MESSAGE_TYPE, IFrameResponseMap } from "@wvdsh/types";
import { takeFocus } from "./focusManager";
import { parentOrigin } from "./parentOrigin";

const RESPONSE_TIMEOUT_MS = 15_000;

// Track pending requests - response can be any value from IFrameResponseMap
type IFrameResponseValue = IFrameResponseMap[keyof IFrameResponseMap];

type PendingRequest = {
  resolve: (data: IFrameResponseValue) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PushHandler = (data: Record<string, unknown>) => void;

export class IFrameMessenger {
  private pendingRequests: Map<string, PendingRequest>;
  private requestIdCounter: number;
  private pushHandlers: Map<string, PushHandler>;

  constructor() {
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.pushHandlers = new Map();

    // Initialize the persistent message listener
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.handleMessage);
    }
  }

  /**
   * Register a handler for a one-way (no requestId) push message from the
   * parent. Used for events like FULLSCREEN_CHANGED where the parent is the
   * source of truth and the SDK just mirrors state.
   */
  onPush(messageType: string, handler: PushHandler): void {
    this.pushHandlers.set(messageType, handler);
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

    const messageType: string | undefined = event.data?.type;
    if (!messageType) return;

    if (messageType === IFRAME_MESSAGE_TYPE.TAKE_FOCUS) {
      takeFocus();
      return;
    }

    const handler = this.pushHandlers.get(messageType);
    if (handler) handler(event.data);
  };

  postToParent(
    requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
    data: Record<string, string | number | boolean>
  ): boolean {
    if (typeof window === "undefined" || !parentOrigin) return false;
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
