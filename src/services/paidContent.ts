import { api, IFRAME_MESSAGE_TYPE, PAID_CONTENT_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashEvents } from "../events";
import type {
  EntitlementsGrantedPayload,
  Purchase,
  PurchaseCompletedPayload,
  PurchaseId
} from "../types";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { readJwtClaim } from "../utils/jwt";
import { showDevPaywall } from "../utils/devPaywall";
import { hasParentFrame } from "../utils/parentOrigin";
import { suspendGamepads } from "../utils/gamepad";
import { suspendPointerLock } from "../utils/pointerLock";

const PAYWALL_TIMEOUT_MS = 10 * 60 * 1000;

export class PaidContentManager extends WavedashManager {
  private paywallOpen = false;
  private restorePointerLock: (() => void) | undefined;
  private restoreGamepads: (() => void) | undefined;
  // Every purchase id this session has seen: the subscription's first result
  // (the boot baseline) plus each one delivered since. One event per purchase.
  private seenPurchaseIds = new Set<PurchaseId>();
  private receivedFirstPurchases = false;
  // Serializes updates so events keep the subscription's order while one awaits
  // a gameplay JWT refresh.
  private purchaseUpdates: Promise<void> = Promise.resolve();
  private unsubscribePurchases: (() => void) | null = null;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.ENTITLEMENTS_GRANTED,
      this.handleEntitlementsGranted
    );
    this.unsubscribePurchases = this.sdk.convexClient.onUpdate(
      api.sdk.paidContent.listActivePurchases,
      {},
      (purchases) => {
        this.purchaseUpdates = this.purchaseUpdates
          .then(() => this.handlePurchasesUpdate(purchases))
          .catch((err) => {
            logger.error("Failed to deliver purchases", err);
          });
      },
      (error) => {
        logger.error(`Purchases subscription error: ${error}`);
      }
    );
  }

  /**
   * One stream for launch and live delivery, so no purchase falls between
   * them, and it works with or without a host (`wavedash dev` included). Like
   * StoreKit's transaction listener: the first result delivers every
   * unfulfilled consumable (bought while the game was closed, or never
   * fulfilled) plus non-consumables bought this session; after that, each new
   * id is a purchase from any source (paywall, game page, gift, another tab).
   * Events queue until the game is ready for them.
   */
  private async handlePurchasesUpdate(purchases: Purchase[]): Promise<void> {
    let fresh = purchases.filter(
      (p) => !this.seenPurchaseIds.has(p.purchaseId)
    );
    for (const purchase of fresh) {
      this.seenPurchaseIds.add(purchase.purchaseId);
    }
    if (!this.receivedFirstPurchases) {
      this.receivedFirstPurchases = true;
      // A non-consumable bought before this session authenticated is ownership
      // the game reads with isEntitled(); one bought since (while the game
      // loaded, even through its own paywall) gets its event. JWT ownership
      // can't tell these apart, since a refresh picks up new purchases.
      const authenticatedAt = await this.sdk.authManager.firstAuthenticatedAt;
      fresh = fresh.filter(
        (p) =>
          p.type !== PAID_CONTENT_TYPE.NON_CONSUMABLE ||
          p.purchasedAt >= authenticatedAt
      );
    }
    await this.notifyPurchasesCompleted(fresh);
  }

  /**
   * Refresh the gameplay JWT first when a non-consumable is included, so
   * isEntitled() is already true by the time the game receives the event.
   */
  private async notifyPurchasesCompleted(
    purchases: PurchaseCompletedPayload[]
  ): Promise<void> {
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
    const entitlements = readJwtClaim<string[]>(jwt, "ents") ?? [];
    return entitlements.includes(contentIdentifier);
  }

  async getEntitlements(): Promise<string[]> {
    const jwt = await this.sdk.ensureGameplayJwt();
    const entitlements = readJwtClaim<string[]>(jwt, "ents") ?? [];
    return entitlements;
  }

  async getUnfulfilledPurchases(): Promise<Purchase[]> {
    return await this.sdk.convexClient.query(
      api.sdk.paidContent.listUnfulfilledPurchases,
      {}
    );
  }

  async fulfillPurchase(purchaseId: PurchaseId): Promise<boolean> {
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
      // Grant via the gameplay JWT (sandbox-gated server-side). PurchaseCompleted
      // arrives from the purchases subscription, as it does in production.
      // There's no host to broadcast the deprecated EntitlementsGranted, so
      // emit it ourselves.
      const { purchase } = await this.sdk.convexClient.mutation(
        api.sdk.paidContent.mockPurchase,
        { contentIdentifier }
      );
      if (purchase.type === PAID_CONTENT_TYPE.NON_CONSUMABLE) {
        await this.sdk.ensureGameplayJwt(true);
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
    this.unsubscribePurchases?.();
    this.unsubscribePurchases = null;
    this.restorePointerLock?.();
    this.restorePointerLock = undefined;
    this.restoreGamepads?.();
    this.restoreGamepads = undefined;
  }
}
