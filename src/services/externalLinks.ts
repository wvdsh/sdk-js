import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import type { WavedashSDK } from "../index";
import { logger } from "../utils/logger";
import { hasParentFrame } from "../utils/parentOrigin";
import { WavedashManager } from "./manager";

/**
 * ExternalLinkManager
 *
 * The game iframe's sandbox has no `allow-popups` — and `allow-popups` can't
 * be scoped to a domain anyway — so `window.open` inside the iframe is dead.
 * Games ask the parent instead, which opens the link only if its domain is on
 * the allowlist.
 *
 * The compat shims below are convenience, not security: game code shares this
 * realm and can unpatch them, but bypassing them just gets a popup the sandbox
 * blocks. The parent is the only enforcement point.
 *
 * User activation: the click happens in the iframe, User Activation v2
 * propagates transient activation to ancestor frames, and the parent's
 * message handler runs inside the ~5s window — so the parent's `window.open`
 * isn't treated as an unsolicited popup.
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
   * Ask the host to open `url` in a new tab. Resolves `false` if the domain
   * isn't allowlisted. Must run inside a user gesture handler.
   */
  async openUrl(url: string): Promise<boolean> {
    if (!hasParentFrame()) {
      window.open(url, "_blank", "noopener,noreferrer");
      return true;
    }
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.OPEN_URL,
      { url }
    );
    if (!response.opened) {
      logger.warn(
        `openUrl("${url}") was blocked — the domain is not on the Wavedash allowlist`
      );
    }
    return response.opened;
  }

  private installCompatShims(): void {
    if (typeof window === "undefined") return;

    const nativeOpen = window.open.bind(window);
    this.nativeOpen = nativeOpen;
    this.patchedOpen = (url, target, features) => {
      const resolved = this.resolveHttpUrl(url);
      if (!resolved) return nativeOpen(url, target, features);
      void this.openUrl(resolved);
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
      void this.openUrl(resolved);
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
