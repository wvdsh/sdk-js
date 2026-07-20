/**
 * Focus-steal suspension for when the host page blocks game input.
 *
 * A game that re-focuses its canvas (on load, on an interval, on blur) steals
 * keyboard input from the host page — from a paywall, the search palette, or
 * a comment box the player is typing into — and the browser scrolls the frame
 * into view as a side effect. The host can't prevent this from outside the
 * frame (`inert` on a cross-origin iframe doesn't block it), so suspension
 * happens here, inside the frame: shim `focus()` to a no-op and release any
 * focus the game already holds. Call the returned dispose fn to restore the
 * native methods.
 */

const hasDom =
  typeof HTMLElement !== "undefined" && typeof document !== "undefined";
// Captured at module load, before anything could have replaced them.
const nativeElementFocus = hasDom ? HTMLElement.prototype.focus : undefined;
const nativeWindowFocus = hasDom ? window.focus : undefined;

// Ref-counted so overlapping suspensions don't restore the native methods early.
let depth = 0;

export function suspendFocusStealing(): () => void {
  if (!hasDom || !nativeElementFocus || !nativeWindowFocus) return () => {};

  if (++depth === 1) {
    HTMLElement.prototype.focus = function () {};
    window.focus = function () {};
  }
  // Hand focus back to the host page: browser-level focus stays inside a
  // cross-origin frame until the frame itself lets go, so the host's own
  // modal/input focus wouldn't reliably take effect otherwise.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--depth === 0) {
      HTMLElement.prototype.focus = nativeElementFocus;
      window.focus = nativeWindowFocus;
    }
  };
}

/**
 * SDK-initiated focus (TAKE_FOCUS from the host). Uses the captured native
 * method so it works regardless of suspension state — only the game's own
 * `focus()` calls are suppressed — and prevents the scroll-into-view that
 * focusing the canvas would otherwise trigger on the host page.
 */
export function focusElement(element: HTMLElement): void {
  (nativeElementFocus ?? HTMLElement.prototype.focus).call(element, {
    preventScroll: true
  });
}
