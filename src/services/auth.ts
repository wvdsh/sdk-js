import { IFRAME_MESSAGE_TYPE, PlayRouteCaller, UrlParams } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Owns the gameplay JWT: fetches it from /auth/refresh, caches it, and feeds
 * it to the Convex client.
 *
 * Convex quirks this works around: a rejected fetcher leaves its socket
 * paused, and a `null` token drops it into a terminal `noAuth` state where it
 * never asks again. So the fetcher never rejects, returns the cached JWT on
 * failure (Convex keeps a good token, or rejects a bad one itself), and we run
 * our own backoff retry that re-arms Convex via `setAuth` on success.
 */
export class AuthManager extends WavedashManager {
  private jwt: string | null = null;
  private jwtPromise: Promise<string> | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private destroyed = false;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.setupConvexAuth();
  }

  /**
   * Cached gameplay JWT, awaiting any in-flight fetch. Concurrent callers share
   * one fetch; a forced refresh serializes behind it (it may predate the event
   * that required it, e.g. a purchase) and becomes the current promise. Only
   * the current promise notifies the parent, so a superseded refresh can't
   * broadcast a stale token
   */
  getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.jwt) return Promise.resolve(this.jwt);
    if (!forceRefresh && this.jwtPromise) return this.jwtPromise;

    const previous = this.jwtPromise;
    const fetchToken = async (): Promise<string> => {
      if (previous) await previous.catch(() => {});
      const query = new URLSearchParams({
        [UrlParams.Caller]: PlayRouteCaller.Wavedash
      });
      // Tell the dev server to skip its cached JWT and re-mint; prod ignores this
      if (forceRefresh) query.set("fresh", "1");
      const response = await fetch(`/auth/refresh?${query.toString()}`, {
        method: "POST",
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw new Error(`Failed to refresh gameplay token: ${response.status}`);
      }
      return response.text();
    };

    const promise = fetchToken()
      .then((token) => {
        // Refreshes are serialized, so tokens resolve in start order
        this.jwt = token;
        this.retryAttempt = 0;
        if (this.jwtPromise === promise) {
          this.sdk.iframeMessenger.postToParent(
            IFRAME_MESSAGE_TYPE.GAMEPLAY_JWT_READY,
            { gameplayJwt: token }
          );
        }
        return token;
      })
      .finally(() => {
        if (this.jwtPromise === promise) this.jwtPromise = null;
      });

    this.jwtPromise = promise;
    return promise;
  }

  private setupConvexAuth(): void {
    this.sdk.convexClient.setAuth(
      ({ forceRefreshToken }) =>
        this.getToken(forceRefreshToken).catch((error: unknown) => {
          logger.error("Failed to fetch gameplay token for Convex", error);
          this.scheduleRetry();
          return this.jwt;
        }),
      // Safety net for failures Convex detects itself (e.g. server rejects token)
      (isAuthenticated) => {
        if (!isAuthenticated) this.scheduleRetry();
      }
    );
  }

  /** Exponential backoff; the counter resets only on a successful fetch */
  private scheduleRetry(): void {
    if (this.destroyed || this.retryTimeout) return;
    const delayMs = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** Math.min(this.retryAttempt, 10)
    );
    this.retryAttempt++;
    logger.warn(
      `Gameplay token refresh failed, retrying in ${delayMs}ms (attempt ${this.retryAttempt})`
    );
    this.retryTimeout = setTimeout(async () => {
      this.retryTimeout = null;
      if (this.destroyed) return;
      try {
        await this.getToken(true);
      } catch {
        this.scheduleRetry();
        return;
      }
      if (!this.destroyed) this.setupConvexAuth();
    }, delayMs);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }
}
