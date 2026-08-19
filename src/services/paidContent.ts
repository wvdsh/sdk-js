import { api, IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashEvents } from "../events";
import type { EntitlementsGrantedPayload } from "../types";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { showDevPaywall } from "../utils/devPaywall";
import { hasParentFrame } from "../utils/parentOrigin";
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
  private paywallOpen = false;
  private restorePointerLock: (() => void) | undefined;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.ENTITLEMENTS_GRANTED,
      this.handleEntitlementsGranted
    );
  }

  /**
   * Host broadcast: the player was granted paid content, from any source (the
   * game's own paywall, the game page purchase list, a gift redemption, or a
   * purchase in another tab). Refresh the gameplay JWT first so the new
   * entitlement is already reflected (isEntitled(), paid-asset requests) by
   * the time the game receives the event.
   */
  private handleEntitlementsGranted = (data: {
    contentIdentifiers: string[];
  }): void => {
    void (async () => {
      try {
        await this.sdk.ensureGameplayJwt(true);
      } catch (err) {
        logger.error("Failed to refresh gameplay JWT after purchase", err);
      }
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.ENTITLEMENTS_GRANTED,
        {
          contentIdentifiers: data.contentIdentifiers
        } satisfies EntitlementsGrantedPayload
      );
    })();
  };

  async isEntitled(contentIdentifier: string): Promise<boolean> {
    const jwt = await this.sdk.ensureGameplayJwt();
    return readEntitlementsFromJwt(jwt).includes(contentIdentifier);
  }

  async getEntitlements(): Promise<string[]> {
    const jwt = await this.sdk.ensureGameplayJwt();
    return readEntitlementsFromJwt(jwt);
  }

  async triggerPaywall(contentIdentifier: string): Promise<boolean> {
    // Short-circuit when the player is already entitled — never show the modal
    // for already-purchased content. Game flows can call triggerPaywall freely.
    if (await this.isEntitled(contentIdentifier)) return true;

    // Don't let the game open a second paywall over an in-progress one.
    if (this.paywallOpen) {
      throw new Error("Paywall already in progress");
    }
    this.paywallOpen = true;

    // Keep the cursor free while the modal is open
    // Restored once the parent responds (or on destroy).
    this.restorePointerLock = suspendPointerLock();

    // Standalone: imitate the host paywall in-page, then grant + refresh so the
    // end state matches a real purchase (entitlement in the JWT, persisted).
    if (!hasParentFrame()) {
      let purchased: boolean;
      try {
        purchased = await showDevPaywall(contentIdentifier);
      } finally {
        this.restorePointerLock?.();
        this.restorePointerLock = undefined;
        this.paywallOpen = false;
      }
      if (!purchased) return false;
      // Grant via the gameplay JWT (sandbox-gated server-side), then refresh so
      // the new entitlement lands in the JWT `ents`. There's no host to
      // broadcast EntitlementsGranted here, so emit it ourselves — games that
      // unlock in the event handler behave the same in `wavedash dev`.
      await this.sdk.convexClient.mutation(api.sdk.paidContent.mockPurchase, {
        contentIdentifier
      });
      await this.sdk.ensureGameplayJwt(true);
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.ENTITLEMENTS_GRANTED,
        {
          contentIdentifiers: [contentIdentifier]
        } satisfies EntitlementsGrantedPayload
      );
      return true;
    }

    let response;
    try {
      response = await this.sdk.iframeMessenger.requestFromParent(
        IFRAME_MESSAGE_TYPE.TRIGGER_PAYWALL,
        { contentIdentifier },
        PAYWALL_TIMEOUT_MS
      );
    } finally {
      this.restorePointerLock?.();
      this.restorePointerLock = undefined;
      this.paywallOpen = false;
    }
    if (!response.purchased) return false;

    // Force refresh JWT so the latest entitlements are reflected
    await this.sdk.ensureGameplayJwt(true);
    return true;
  }

  isPaywallOpen(): boolean {
    return this.paywallOpen;
  }

  destroy(): void {
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.ENTITLEMENTS_GRANTED,
      this.handleEntitlementsGranted
    );
    this.restorePointerLock?.();
    this.restorePointerLock = undefined;
  }
}
