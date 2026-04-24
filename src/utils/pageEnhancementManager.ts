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
 *   document when nothing in the iframe absorbs it. We only preventDefault
 *   when (a) the focused element doesn't use the key itself (inputs, buttons,
 *   media, etc.) and (b) no ancestor — including the root scrolling element —
 *   can actually scroll in the requested direction. Modifier-key combos are
 *   left alone since they're often browser shortcuts (Cmd+ArrowLeft = back).
 * - F3 (find-next): suppressed so the browser's find bar doesn't steal the
 *   key from the game.
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

// Tags that always handle scroll keys themselves: text input + cursor
// movement, and media elements where Space toggles play and arrows seek.
const SELF_HANDLING_TAGS = new Set([
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "VIDEO",
  "AUDIO"
]);

// Tags activated by Space (but not by arrows).
const SPACE_ACTIVATES_TAGS = new Set(["BUTTON", "SUMMARY"]);

// ARIA roles activated by Space.
const SPACE_ACTIVATES_ROLES = new Set([
  "button",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab"
]);

function consumesKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (SELF_HANDLING_TAGS.has(target.tagName)) return true;
  if (key === " ") {
    if (SPACE_ACTIVATES_TAGS.has(target.tagName)) return true;
    const role = target.getAttribute("role");
    if (role !== null && SPACE_ACTIVATES_ROLES.has(role)) return true;
  }
  return false;
}

type Axis = "x" | "y";
type Direction = -1 | 1;

function scrollIntent(
  key: string,
  shiftKey: boolean
): { axis: Axis; direction: Direction } | null {
  switch (key) {
    case "ArrowUp":
    case "PageUp":
    case "Home":
      return { axis: "y", direction: -1 };
    case "ArrowDown":
    case "PageDown":
    case "End":
      return { axis: "y", direction: 1 };
    case "ArrowLeft":
      return { axis: "x", direction: -1 };
    case "ArrowRight":
      return { axis: "x", direction: 1 };
    case " ":
      return { axis: "y", direction: shiftKey ? -1 : 1 };
    default:
      return null;
  }
}

function canScroll(
  el: Element,
  axis: Axis,
  direction: Direction,
  isRoot: boolean
): boolean {
  // Root scrolls on `visible`/`auto`/`scroll`; inner elements need `auto`/`scroll`.
  // Both are blocked by `hidden`/`clip`.
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow === "hidden" || overflow === "clip") return false;
  if (!isRoot && overflow !== "auto" && overflow !== "scroll") return false;
  if (axis === "y") {
    return direction < 0
      ? el.scrollTop > 0
      : el.scrollTop + el.clientHeight < el.scrollHeight;
  }
  return direction < 0
    ? el.scrollLeft > 0
    : el.scrollLeft + el.clientWidth < el.scrollWidth;
}

function someAncestorScrolls(
  start: Element | null,
  axis: Axis,
  direction: Direction
): boolean {
  const root = document.scrollingElement;
  let el: Element | null = start;
  while (el && el !== root) {
    if (canScroll(el, axis, direction, false)) return true;
    el = el.parentElement;
  }
  return root ? canScroll(root, axis, direction, true) : false;
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
    if (event.defaultPrevented) return;
    if (event.key === "F3") {
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!SCROLL_KEYS.has(event.key)) return;
    if (consumesKey(event.target, event.key)) return;

    const intent = scrollIntent(event.key, event.shiftKey);
    if (!intent) return;

    const start =
      event.target instanceof Element ? event.target : document.activeElement;
    if (someAncestorScrolls(start, intent.axis, intent.direction)) return;

    event.preventDefault();
  };
}
