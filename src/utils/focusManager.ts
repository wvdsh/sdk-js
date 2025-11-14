export function takeFocus() {
  if (typeof document !== "undefined") {
    const gameFocusTargets =
      document.getElementsByClassName("game-focus-target");
    if (gameFocusTargets.length > 0) {
      (gameFocusTargets[0] as HTMLElement).focus();
    } else {
      // Fallback: focus the first focusable element (canvas, input, button, etc.)
      const focusableElement = document.querySelector(
        "canvas, input, button, [tabindex]:not([tabindex='-1'])"
      ) as HTMLElement;
      if (focusableElement) {
        focusableElement.focus();
      }
    }
  }
}
