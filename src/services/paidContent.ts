import { api, IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";

const PAYWALL_TIMEOUT_MS = 10 * 60 * 1000;

interface PaywallOffer {
  paidContentId: string;
  contentIdentifier: string;
  title: string;
  message: string;
  features: string[];
  buttonLabel: string;
  imageR2Key?: string;
  priceCents: number;
}

function parseEntsFromJwt(jwt: string): string[] {
  try {
    const [, payloadB64] = jwt.split(".");
    if (!payloadB64) return [];
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const json = atob(padded);
    const payload = JSON.parse(json) as { ents?: unknown };
    if (Array.isArray(payload.ents)) {
      return payload.ents.filter((e): e is string => typeof e === "string");
    }
    return [];
  } catch (err) {
    logger.warn("Failed to parse ents from gameplay JWT", err);
    return [];
  }
}

export class PaidContentManager extends WavedashManager {
  async userHasAccess(contentIdentifier: string): Promise<boolean> {
    const jwt = await this.sdk.ensureGameplayJwt();
    return parseEntsFromJwt(jwt).includes(contentIdentifier);
  }

  async triggerPaywall(
    contentIdentifier: string
  ): Promise<{ purchased: boolean }> {
    // Short-circuit when the player is already entitled — never show the modal
    // for already-purchased content. Game flows can call triggerPaywall freely.
    if (await this.userHasAccess(contentIdentifier)) {
      return { purchased: true };
    }

    let offer: PaywallOffer;
    try {
      offer = (await this.sdk.convexClient.query(api.sdk.paidContent.getOffer, {
        contentIdentifier
      })) as PaywallOffer;
    } catch (error) {
      logger.error("Failed to fetch paywall offer", error);
      return { purchased: false };
    }

    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.TRIGGER_PAYWALL,
      { offer },
      PAYWALL_TIMEOUT_MS
    );
    if (!response.purchased) return { purchased: false };

    try {
      await this.sdk.convexClient.mutation(
        api.sdk.paidContent.mockFulfillPurchase,
        { paidContentId: offer.paidContentId }
      );
    } catch (error) {
      logger.error("Mock fulfill failed", error);
      return { purchased: false };
    }

    // Force a JWT refresh so the new `ents` entry is live before we return
    await this.sdk.ensureGameplayJwt(true);
    return { purchased: true };
  }
}
