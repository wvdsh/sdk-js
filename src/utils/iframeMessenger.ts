/**
 * Utilities for handling iframe messaging between the iframe'd Wavedash SDK and the parent window.
 * Assumes window is defined and this is only ever running inside an iframe.
 *
 * TODO: Look into Vercel's BIDC for this https://github.com/vercel/bidc
 */

import type { IFrameResponseMap } from "../_generated/constants";
import { IFRAME_MESSAGE_TYPE } from "../_generated/constants";

const RESPONSE_TIMEOUT_MS = 5_000;

// Derive parent origin from iframe URL pattern
// iframe: [gameSlug].builds.[parentDomain]
// parent: [parentDomain]
function deriveParentOrigin(): string {
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

const PARENT_ORIGIN = deriveParentOrigin();

export function postToParent(
  requestType: (typeof IFRAME_MESSAGE_TYPE)[keyof typeof IFRAME_MESSAGE_TYPE],
  data: Record<string, string | number | boolean>
): boolean {
  if (typeof window === "undefined" || !PARENT_ORIGIN) return false;
  window.parent.postMessage({ type: requestType, ...data }, PARENT_ORIGIN);
  return true;
}

export async function requestFromParent<T extends keyof IFrameResponseMap>(
  requestType: T
): Promise<IFrameResponseMap[T]> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !PARENT_ORIGIN) {
      reject(new Error("Parent origin not found"));
      return;
    }

    const timeout = setTimeout(() => {
      reject(
        new Error(
          `${requestType} request timed out after ${RESPONSE_TIMEOUT_MS}ms`
        )
      );
    }, RESPONSE_TIMEOUT_MS);

    const handleMessage = (event: MessageEvent) => {
      if (
        event.data?.type === "response" &&
        event.data?.requestType === requestType
      ) {
        clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        // Validate origin to prevent JWT spoofing and other attacks
        if (event.origin === PARENT_ORIGIN) {
          resolve(event.data.data);
        } else {
          reject(
            new Error(`Ignored message from untrusted origin: ${event.origin}`)
          );
        }
      }
    };

    window.addEventListener("message", handleMessage);
    window.parent.postMessage({ type: requestType }, PARENT_ORIGIN);
  });
}
