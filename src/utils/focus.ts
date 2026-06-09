/**
 * Move keyboard focus to the game so it receives input without the player
 * clicking first — used after load completes and when the overlay hands focus
 * back. Prefers an explicit `.game-focus-target`, otherwise the first focusable
 * element (canvas, input, button, …).
 */
export function takeFocus(): void {
  if (typeof document === "undefined") return;

  const gameFocusTargets = document.getElementsByClassName("game-focus-target");
  if (gameFocusTargets.length > 0) {
    (gameFocusTargets[0] as HTMLElement).focus();
    return;
  }

  const focusableElement = document.querySelector(
    "canvas, input, button, [tabindex]:not([tabindex='-1'])"
  ) as HTMLElement | null;
  focusableElement?.focus();
}
