/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import { IFRAME_MESSAGE_TYPE, IFrameResponseMap } from "@wvdsh/types";
import { takeFocus } from "./focusManager";
import { parentOrigin } from "./parentOrigin";

const RESPONSE_TIMEOUT_MS = 5_000;

// Track pending requests
type PendingRequest = {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class IFrameMessenger {
  private pendingRequests: Map<string, PendingRequest>;
  private requestIdCounter: number;

  constructor() {
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;

    // Initialize the persistent message listener
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.handleMessage);
    }
  }

  // Arrow function automatically captures 'this' from the class instance
  private handleMessage = (event: MessageEvent): void => {
    // Validate origin to prevent JWT spoofing and other attacks
    if (event.origin !== parentOrigin) {
      console.warn(`Ignored message from untrusted origin: ${event.origin}`);
      return;
    }

    if (event.data?.requestId) {
      const pending = this.pendingRequests.get(event.data.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(event.data.requestId);
        pending.resolve(event.data.data);
      }
    } else if (event.data?.type === IFRAME_MESSAGE_TYPE.TAKE_FOCUS) {
      takeFocus();
    }
  };

  postToParent(
    requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
    data: Record<string, string | number | boolean>
  ): boolean {
    if (typeof window === "undefined" || !parentOrigin)
      return false;
    window.parent.postMessage(
      { type: requestType, ...data },
      parentOrigin
    );
    return true;
  }

  async requestFromParent<T extends keyof IFrameResponseMap>(
    requestType: T
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

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      window.parent.postMessage(
        { type: requestType, requestId },
        parentOrigin
      );
    });
  }
}
