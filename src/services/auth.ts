import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { readJwtClaim } from "../utils/jwt";

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
  // `iat` timestamp of the first gameplay JWT
  readonly firstAuthenticatedAt: Promise<number>;
  private resolveFirstAuthenticatedAt: ((issuedAtMs: number) => void) | null =
    null;
  private jwtPromise: Promise<string> | null = null;
  private retryTimeout: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private destroyed = false;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.firstAuthenticatedAt = new Promise((resolve) => {
      this.resolveFirstAuthenticatedAt = resolve;
    });
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
      // `fresh` tells the dev server to skip its cached JWT and re-mint; prod ignores it
      const response = await fetch(
        `/auth/refresh${forceRefresh ? "?fresh=1" : ""}`,
        {
          method: "POST",
          credentials: "same-origin"
        }
      );
      if (!response.ok) {
        throw new Error(`Failed to refresh gameplay token: ${response.status}`);
      }
      return response.text();
    };

    const promise = fetchToken()
      .then((token) => {
        // Refreshes are serialized, so tokens resolve in start order
        this.jwt = token;
        if (this.resolveFirstAuthenticatedAt) {
          this.resolveFirstAuthenticatedAt(
            (readJwtClaim<number>(token, "iat") ?? 0) * 1000
          );
          this.resolveFirstAuthenticatedAt = null;
        }
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
        this.getToken(forceRefreshToken)
          .then((token) => {
            // Convex has a token and will run its own refresh schedule. Only
            // this path clears the retry: a token fetched by another caller
            // never reaches Convex, so its timer must survive
            this.clearRetry();
            return token;
          })
          .catch((error: unknown) => {
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

  private clearRetry(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout);
      this.retryTimeout = null;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.clearRetry();
  }
}
