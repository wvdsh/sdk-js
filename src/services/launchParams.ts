import { type GameLaunchParams, LAUNCH_PARAM_PREFIX } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { logger } from "../utils/logger";
import { WavedashManager } from "./manager";

/**
 * LaunchParamManager
 *
 * Single owner of the game's launch params. Two sources feed it:
 *
 * - `SDKConfig.launchParams`, minted by the host at sign-in and reused for the
 *   whole session.
 * - The frame's own URL: every `wd_`-prefixed query param (see
 *   `LAUNCH_PARAM_PREFIX`). Standalone (`wavedash dev`) this is the only
 *   source, since the page the player opened is the game itself.
 *
 * They are merged with the URL taking priority — the URL reflects what the
 * player actually navigated to, while the config can be stale by the time a
 * page is (re)loaded.
 *
 * Writes go through `set()`, which updates the in-memory params and mirrors
 * the change onto the frame URL via `history.replaceState` so a reload or a
 * copied link lands the player back in the same state.
 */
export class LaunchParamManager extends WavedashManager {
  private params: GameLaunchParams;

  constructor(sdk: WavedashSDK, configParams: GameLaunchParams = {}) {
    super(sdk);
    this.params = { ...configParams, ...this.readFromUrl() };
  }

  /** Snapshot of the current launch params. */
  get(): GameLaunchParams {
    return { ...this.params };
  }

  /**
   * Set (or clear, with `null`) a launch param and sync it to the frame URL.
   * `key` is the bare name (e.g. `"lobby"`); the prefix is applied on the URL.
   */
  set(key: string, value: string | null): void {
    if (value === null) {
      delete this.params[key];
    } else {
      this.params[key] = value;
    }
    this.writeToUrl(key, value);
  }

  private readFromUrl(): GameLaunchParams {
    const params: GameLaunchParams = {};
    if (typeof window === "undefined") return params;
    new URLSearchParams(window.location.search).forEach((value, key) => {
      if (key.startsWith(LAUNCH_PARAM_PREFIX)) {
        params[key.slice(LAUNCH_PARAM_PREFIX.length)] = value;
      }
    });
    return params;
  }

  private writeToUrl(key: string, value: string | null): void {
    if (typeof window === "undefined") return;
    const urlKey = `${LAUNCH_PARAM_PREFIX}${key}`;
    const url = new URL(window.location.href);
    if (value === null) {
      url.searchParams.delete(urlKey);
    } else {
      url.searchParams.set(urlKey, value);
    }
    if (url.href === window.location.href) return;
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch (err) {
      // e.g. a sandboxed iframe with an opaque origin refuses replaceState.
      // The in-memory params are still correct; only the URL mirror is lost.
      const message = err instanceof Error ? err.message : String(err);
      logger.debug(
        `Could not sync launch param "${key}" to the URL: ${message}`
      );
    }
  }
}
