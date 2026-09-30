import { api, IFRAME_MESSAGE_TYPE, PAID_CONTENT_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashEvents } from "../events";
import type {
  EntitlementsGrantedPayload,
  FulfillPurchaseResult,
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
  // Serializes updates so events keep the subscription's order while one awaits
  // a gameplay JWT refresh.
  private purchaseUpdates: Promise<void> = Promise.resolve();
  // Serializes entitlement checks so one purchase triggers one JWT refresh.
  private entitlementChecks: Promise<void> = Promise.resolve();
  private unsubscribePurchases: (() => void) | null = null;
  private destroyed = false;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    // Older durables are ownership read via isEntitled(), not events.
    void this.sdk.authManager.firstAuthenticatedAt.then((since) => {
      if (this.destroyed) return;
      this.unsubscribePurchases = this.sdk.convexClient.onUpdate(
        api.sdk.paidContent.listNewAndUnfulfilled,
        { since },
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
    });
  }

  /**
   * One stream for launch and live delivery, so no purchase falls between
   * them, and it works with or without a host (`wavedash dev` included). Like
   * StoreKit's transaction listener: the first result delivers every
   * unfulfilled consumable (bought while the game was closed, or never
   * fulfilled) plus durables bought this session; after that, each new
   * id is a purchase from any source (paywall, game page, gift, another tab).
   * Events queue until the game is ready for them.
   */
  private async handlePurchasesUpdate(purchases: Purchase[]): Promise<void> {
    const fresh = purchases.filter(
      (p) => !this.seenPurchaseIds.has(p.purchaseId)
    );
    for (const purchase of fresh) {
      this.seenPurchaseIds.add(purchase.purchaseId);
    }
    await this.notifyPurchasesCompleted(fresh);
  }

  /**
   * Make sure the gameplay JWT entitles every new durable first, so
   * isEntitled() is already true by the time the game receives the events.
   * New durables also fire the deprecated EntitlementsGranted, one
   * event per update so a bundle's contents arrive together.
   */
  private async notifyPurchasesCompleted(
    purchases: PurchaseCompletedPayload[]
  ): Promise<void> {
    const granted = purchases
      .filter((p) => p.type === PAID_CONTENT_TYPE.DURABLE)
      .map((p) => p.contentIdentifier);
    if (granted.length > 0) {
      try {
        await this.ensureJwtEntitles(granted);
      } catch (err) {
        // A failed refresh must not undo a completed purchase.
        logger.error("Failed to refresh gameplay JWT after purchase", err);
      }
    }
    for (const purchase of purchases) {
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.PURCHASE_COMPLETED,
        purchase
      );
    }
    if (granted.length > 0) {
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.ENTITLEMENTS_GRANTED,
        {
          contentIdentifiers: [...new Set(granted)]
        } satisfies EntitlementsGrantedPayload
      );
    }
  }

  /** Force-refresh the gameplay JWT only if its `ents` lacks any of these identifiers. */
  private ensureJwtEntitles(contentIdentifiers: string[]): Promise<void> {
    const check = async () => {
      const jwt = await this.sdk.ensureGameplayJwt();
      const entitlements = readJwtClaim<string[]>(jwt, "ents") ?? [];
      if (contentIdentifiers.every((id) => entitlements.includes(id))) return;
      await this.sdk.ensureGameplayJwt(true);
    };
    const result = this.entitlementChecks.then(check, check);
    this.entitlementChecks = result.catch(() => {});
    return result;
  }

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
    const purchases = await this.sdk.convexClient.query(
      api.sdk.paidContent.listNewAndUnfulfilled,
      { since: await this.sdk.authManager.firstAuthenticatedAt }
    );
    return purchases.filter((p) => !p.fulfilled);
  }

  async fulfillPurchase(
    purchaseId: PurchaseId
  ): Promise<FulfillPurchaseResult> {
    return await this.sdk.convexClient.mutation(
      api.sdk.paidContent.fulfillPurchase,
      { purchaseId }
    );
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
      // Grant via the gameplay JWT (sandbox-gated server-side). Its events
      // arrive from the purchases subscription, as they do in production.
      const purchase = await this.sdk.convexClient.mutation(
        api.sdk.paidContent.mockPurchase,
        { contentIdentifier }
      );
      if (purchase.type === PAID_CONTENT_TYPE.DURABLE) {
        await this.ensureJwtEntitles([contentIdentifier]);
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

    // A consumable isn't in the JWT (PurchaseCompleted delivers it), so don't
    // let a failed refresh report a completed purchase as failed. Otherwise
    // (a type-less response is an older host) refresh before returning, so
    // isEntitled() is already true.
    if (response.type !== PAID_CONTENT_TYPE.CONSUMABLE) {
      await this.ensureJwtEntitles([contentIdentifier]);
    }
    return true;
  }

  isPaywallOpen(): boolean {
    return this.paywallOpen;
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribePurchases?.();
    this.unsubscribePurchases = null;
    this.restorePointerLock?.();
    this.restorePointerLock = undefined;
    this.restoreGamepads?.();
    this.restoreGamepads = undefined;
  }
}
