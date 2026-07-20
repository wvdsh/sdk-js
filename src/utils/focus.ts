import { focusElement } from "./focusGuard";

/**
 * Move keyboard focus to the game so it receives input without the player
 * clicking first — used after load completes and when the overlay hands focus
 * back. Prefers an explicit `.game-focus-target`, otherwise the first focusable
 * element (canvas, input, button, …). Goes through `focusElement` so it works
 * even while game-initiated focus is suspended, and never scrolls the host
 * page.
 */
export function takeFocus(): void {
  if (typeof document === "undefined") return;

  const gameFocusTargets = document.getElementsByClassName("game-focus-target");
  if (gameFocusTargets.length > 0) {
    focusElement(gameFocusTargets[0] as HTMLElement);
    return;
  }

  const focusableElement = document.querySelector(
    "canvas, input, button, [tabindex]:not([tabindex='-1'])"
  ) as HTMLElement | null;
  if (focusableElement) focusElement(focusableElement);
}
