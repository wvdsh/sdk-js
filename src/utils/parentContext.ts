/**
 * Whether the SDK is running embedded in a Wavedash parent frame.
 *
 * A whole class of SDK features — fullscreen, mute, the overlay, the paywall —
 * is owned by the parent (mainsite) and driven over postMessage. When the game
 * runs outside a parent frame (top-level standalone, `wavedash dev`, or with no
 * parent origin configured) there is nobody to answer those messages, so the
 * calls are disabled rather than left to hang until they time out.
 *
 * `window.parent === window` is only true at the top level, i.e. when we are
 * not inside an iframe. We additionally require a configured parent origin
 * since every postMessage to the parent needs one to target.
 */
import { getParentOrigin } from "./parentOrigin";

export function hasParentContext(): boolean {
  if (typeof window === "undefined") return false;
  if (window.parent === window) return false;
  return getParentOrigin() !== "";
}
