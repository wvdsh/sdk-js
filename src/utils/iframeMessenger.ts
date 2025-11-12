/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import type { IFrameResponseMap } from "../_generated/constants";
import { IFRAME_MESSAGE_TYPE } from "../_generated/constants";

const RESPONSE_TIMEOUT_MS = 5_000;

// Track pending requests
type PendingRequest = {
  resolve: (data: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class IFrameMessenger {
  private expectedParentOrigin: string;
  private pendingRequests: Map<string, PendingRequest>;
  private requestIdCounter: number;

  constructor() {
    this.pendingRequests = new Map();
    this.requestIdCounter = 0;
    this.expectedParentOrigin = this.deriveParentOrigin();

    // Initialize the persistent message listener
    if (typeof window !== "undefined") {
      window.addEventListener("message", this.handleMessage);
    }
  }

  /**
   * Derive parent origin from iframe URL pattern
   * iframe: [gameSlug].builds.[parentDomain]
   * parent: [parentDomain]
   */
  private deriveParentOrigin(): string {
    if (typeof window === "undefined") return "";
    const iframeHost = window.location.hostname;
    const match = iframeHost.match(/^[\w-]+\.builds\.(.+)$/);
    if (match) {
      const parentDomain = match[1];
      return `${window.location.protocol}//${parentDomain}`;
    }
    console.error(`Invalid iframe hostname pattern: ${iframeHost}`);
    return "";
  }

  // Arrow function automatically captures 'this' from the class instance
  private handleMessage = (event: MessageEvent): void => {
    // Validate origin to prevent JWT spoofing and other attacks
    if (event.origin !== this.expectedParentOrigin) {
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
      console.log("[IFRAME MESSENGER] Taking focus");
      if (typeof document !== "undefined") {
        document.getElementById("wavedash-target")?.focus();
      }
    }
  };

  postToParent(
    requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
    data: Record<string, string | number | boolean>
  ): boolean {
    if (typeof window === "undefined" || !this.expectedParentOrigin)
      return false;
    window.parent.postMessage(
      { type: requestType, ...data },
      this.expectedParentOrigin
    );
    return true;
  }

  async requestFromParent<T extends keyof IFrameResponseMap>(
    requestType: T
  ): Promise<IFrameResponseMap[T]> {
    return new Promise((resolve, reject) => {
      if (typeof window === "undefined" || !this.expectedParentOrigin) {
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
        this.expectedParentOrigin
      );
    });
  }
}
