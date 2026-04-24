/**
 * PageEnhancementManager
 *
 * Browser default behaviors that get in the way when the SDK is running
 * inside an iframe. Centralized here so the list of "things we override for
 * the host page" has one home.
 *
 * Currently handles:
 * - Scroll-key default actions (Space / Arrows / PageUp-Down / Home / End).
 *   Keyboard events don't cross the cross-origin iframe boundary, but the
 *   browser's default scroll action can chain from the iframe to the parent
 *   document when the iframe can't scroll. preventDefault inside the iframe
 *   stops that. Typing contexts (input/textarea/select/contenteditable) are
 *   left untouched so in-game UI keeps working.
 */

const SCROLL_KEYS = new Set([
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End"
]);

function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export class PageEnhancementManager {
  private registered = false;

  register() {
    if (this.registered) return;
    if (typeof window === "undefined") return;
    this.registered = true;

    window.addEventListener("keydown", this.handleKeyDown);
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (isTypingContext(event.target)) return;
    if (SCROLL_KEYS.has(event.key)) {
      event.preventDefault();
    }
  };
}
