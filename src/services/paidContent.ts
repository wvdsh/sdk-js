import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { suspendPointerLock } from "../utils/pointerLock";

const PAYWALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Decode the gameplay JWT payload to read the `ents` claim (short on the wire
 * to keep token size down; surfaced as `entitlements` everywhere else). We
 * don't verify the signature here — a hostile client can patch this function
 * to return whatever it wants either way, so verifying locally adds bar but
 * no real boundary. The play worker re-verifies the JWT signature on every
 * paid-asset request — that's the actual security gate.
 *
 * UTF-8 safe: claims may carry arbitrary user/file paths (e.g. r2key).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = jwt.split(".");
    if (!payloadB64) return null;
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    logger.warn("Failed to decode JWT payload", err);
    return null;
  }
}

function readEntitlementsFromJwt(jwt: string): string[] {
  const payload = decodeJwtPayload(jwt);
  const ents = payload?.ents;
  if (!Array.isArray(ents)) return [];
  return ents.filter((e): e is string => typeof e === "string");
}

export class PaidContentManager extends WavedashManager {
  async isEntitled(contentId: string): Promise<boolean> {
    const jwt = await this.sdk.ensureGameplayJwt();
    return readEntitlementsFromJwt(jwt).includes(contentId);
  }

  async getEntitlements(): Promise<string[]> {
    const jwt = await this.sdk.ensureGameplayJwt();
    return readEntitlementsFromJwt(jwt);
  }

  async triggerPaywall(contentIdentifier: string): Promise<boolean> {
    // Short-circuit when the player is already entitled — never show the modal
    // for already-purchased content. Game flows can call triggerPaywall freely.
    if (await this.isEntitled(contentIdentifier)) return true;

    // Keep the cursor free while the modal is open (some games re-grab pointer
    // lock every frame). Restored once the parent responds.
    const restorePointerLock = suspendPointerLock();

    let response;
    try {
      response = await this.sdk.iframeMessenger.requestFromParent(
        IFRAME_MESSAGE_TYPE.TRIGGER_PAYWALL,
        { contentIdentifier },
        PAYWALL_TIMEOUT_MS
      );
    } finally {
      restorePointerLock();
    }
    if (!response.purchased) return false;

    // Force refresh JWT so the latest entitlements are reflected
    await this.sdk.ensureGameplayJwt(true);
    return true;
  }
}
