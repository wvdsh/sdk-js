import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { logger } from "../utils/logger";
import { hasParentFrame } from "../utils/parentOrigin";
import { WavedashManager } from "./manager";

/**
 * ExternalLinkManager
 *
 * The game iframe's sandbox has no `allow-popups`, so `window.open` inside the
 * iframe is dead. Rather than navigate the player away mid-session, Wavedash
 * copies the link to their clipboard and the host shows an in-game toast.
 *
 * The compat shims below are convenience, not security: game code shares this
 * realm and can unpatch them, but bypassing them just gets a popup the sandbox
 * blocks — and a game can already reach the clipboard directly, since the
 * iframe is granted `clipboard-write`.
 */
export class ExternalLinkManager extends WavedashManager {
  // Originals, restored on destroy.
  private nativeOpen: typeof window.open | null = null;
  private patchedOpen: typeof window.open | null = null;
  private clickHandler: ((event: MouseEvent) => void) | null = null;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    // Standalone (`wavedash dev`): the page is top-level, popups work natively.
    if (!hasParentFrame()) return;
    this.installCompatShims();
  }

  /**
   * Copy `url` to the player's clipboard and have the host show an in-game
   * toast. Resolves `false` if the clipboard write failed. Must run inside a
   * user gesture handler.
   *
   * The write happens here rather than in the host because
   * `navigator.clipboard` only honours user activation raised in the calling
   * frame — activation propagated up from this iframe doesn't count out there.
   * The iframe is granted `clipboard-write` for exactly this.
   */
  async copyLink(url: string): Promise<boolean> {
    const resolved = this.resolveHttpUrl(url);
    if (!resolved) {
      logger.warn(`copyLink("${url}") ignored — not an http(s) URL`);
      return false;
    }
    try {
      await navigator.clipboard.writeText(resolved);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`copyLink("${resolved}") failed to write the clipboard: ${message}`);
      return false;
    }
    this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LINK_COPIED, {
      url: resolved
    });
    return true;
  }

  private installCompatShims(): void {
    if (typeof window === "undefined") return;

    const nativeOpen = window.open.bind(window);
    this.nativeOpen = nativeOpen;
    this.patchedOpen = (url, target, features) => {
      const resolved = this.resolveHttpUrl(url);
      // `_self`/`_parent`/`_top` navigate an existing frame rather than open
      // one — the sandbox permits that, so leave those on the native path.
      const navigatesInPlace =
        typeof target === "string" &&
        ["_self", "_parent", "_top"].includes(target.toLowerCase());
      if (!resolved || navigatesInPlace) return nativeOpen(url, target, features);
      void this.copyLink(resolved);
      // Matches what the sandbox already hands back for a blocked popup, so
      // games that null-check the handle keep working.
      return null;
    };
    window.open = this.patchedOpen;

    this.clickHandler = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const resolved = this.resolveHttpUrl(anchor.href);
      if (!resolved || new URL(resolved).origin === window.location.origin) {
        return;
      }
      event.preventDefault();
      void this.copyLink(resolved);
    };
    document.addEventListener("click", this.clickHandler, true);
  }

  override destroy(): void {
    // Only restore if nothing else patched over us in the meantime.
    if (this.nativeOpen && window.open === this.patchedOpen) {
      window.open = this.nativeOpen;
    }
    if (this.clickHandler) {
      document.removeEventListener("click", this.clickHandler, true);
    }
    this.nativeOpen = null;
    this.patchedOpen = null;
    this.clickHandler = null;
    super.destroy();
  }

  private resolveHttpUrl(url: string | URL | undefined): string | null {
    if (!url) return null;
    try {
      const resolved = new URL(String(url), window.location.href);
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
        return null;
      }
      return resolved.href;
    } catch {
      return null;
    }
  }
}
