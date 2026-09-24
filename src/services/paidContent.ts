import {
  api,
  IFRAME_MESSAGE_TYPE,
  type IFrameEventPayloadMap,
  PAID_CONTENT_TYPE
} from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashEvents } from "../events";
import type {
  EntitlementsGrantedPayload,
  Id,
  Purchase,
  PurchaseCompletedPayload
} from "../types";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { showDevPaywall } from "../utils/devPaywall";
import { hasParentFrame } from "../utils/parentOrigin";
import { suspendGamepads } from "../utils/gamepad";
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
  private restoreGamepads: (() => void) | undefined;
  // Launch delivery and the host broadcast can both see a purchase landing at
  // boot; each purchase fires PurchaseCompleted once per session.
  private deliveredPurchaseIds = new Set<Id<"userPaidContent">>();

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.ENTITLEMENTS_GRANTED,
      this.handleEntitlementsGranted
    );
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.PURCHASE_COMPLETED,
      this.handlePurchaseCompleted
    );
    void this.deliverUnfulfilledPurchases();
  }

  /**
   * Like StoreKit's launch-time delivery of unfinished transactions: every
   * consumable not yet fulfilled (bought while the game was closed, or granted
   * but never fulfilled) arrives as PurchaseCompleted, queued until the game is
   * ready for events, so games can't strand one by forgetting a recovery call.
   */
  private async deliverUnfulfilledPurchases(): Promise<void> {
    try {
      await this.notifyPurchasesCompleted(await this.getUnfulfilledPurchases());
    } catch (err) {
      logger.error("Failed to deliver unfulfilled purchases at launch", err);
    }
  }

  /**
   * Host broadcast: purchases made while the game is running, from any source
   * (the game's own paywall, the game page, a gift, another tab). One game
   * event per purchase; unfulfilled consumables are the game's to fulfill.
   */
  private handlePurchaseCompleted = (
    data: IFrameEventPayloadMap[typeof IFRAME_MESSAGE_TYPE.PURCHASE_COMPLETED]
  ): void => {
    void this.notifyPurchasesCompleted(
      data.purchases.map((purchase) => ({
        ...purchase,
        purchaseId: purchase.purchaseId as Id<"userPaidContent">
      }))
    );
  };

  /**
   * Refresh the gameplay JWT first when a non-consumable is included, so
   * isEntitled() is already true by the time the game receives the event.
   */
  private async notifyPurchasesCompleted(
    candidates: PurchaseCompletedPayload[]
  ): Promise<void> {
    const purchases = candidates.filter(
      (p) => !this.deliveredPurchaseIds.has(p.purchaseId)
    );
    for (const purchase of purchases) {
      this.deliveredPurchaseIds.add(purchase.purchaseId);
    }
    if (purchases.some((p) => p.type === PAID_CONTENT_TYPE.NON_CONSUMABLE)) {
      try {
        await this.sdk.ensureGameplayJwt(true);
      } catch (err) {
        logger.error("Failed to refresh gameplay JWT after purchase", err);
      }
    }
    for (const purchase of purchases) {
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.PURCHASE_COMPLETED,
        purchase
      );
    }
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

  async getUnfulfilledPurchases(): Promise<Purchase[]> {
    return await this.sdk.convexClient.query(
      api.sdk.paidContent.listUnfulfilledPurchases,
      {}
    );
  }

  async fulfillPurchase(purchaseId: Id<"userPaidContent">): Promise<boolean> {
    const { fulfilled } = await this.sdk.convexClient.mutation(
      api.sdk.paidContent.fulfillPurchase,
      { purchaseId }
    );
    return fulfilled;
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

    // Keep the cursor free and gamepad input out of the game while the modal is open
    // Restored once the parent responds (or on destroy).
    this.restorePointerLock = suspendPointerLock();
    this.restoreGamepads = suspendGamepads();

    // Standalone: imitate the host paywall in-page, then grant + refresh so the
    // end state matches a real purchase (entitlement in the JWT, persisted).
    if (!hasParentFrame()) {
      let purchased: boolean;
      try {
        purchased = await showDevPaywall(contentIdentifier);
      } finally {
        this.restorePointerLock?.();
        this.restorePointerLock = undefined;
        this.restoreGamepads?.();
        this.restoreGamepads = undefined;
        this.paywallOpen = false;
      }
      if (!purchased) return false;
      // Grant via the gameplay JWT (sandbox-gated server-side). There's no host
      // to broadcast PurchaseCompleted / EntitlementsGranted here, so emit them
      // ourselves — games behave the same in `wavedash dev`.
      const { purchase } = await this.sdk.convexClient.mutation(
        api.sdk.paidContent.mockPurchase,
        { contentIdentifier }
      );
      await this.notifyPurchasesCompleted([purchase]);
      if (purchase.type === PAID_CONTENT_TYPE.NON_CONSUMABLE) {
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.ENTITLEMENTS_GRANTED,
          {
            contentIdentifiers: [contentIdentifier]
          } satisfies EntitlementsGrantedPayload
        );
      }
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
      this.restoreGamepads?.();
      this.restoreGamepads = undefined;
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
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.PURCHASE_COMPLETED,
      this.handlePurchaseCompleted
    );
    this.restorePointerLock?.();
    this.restorePointerLock = undefined;
    this.restoreGamepads?.();
    this.restoreGamepads = undefined;
  }
}
