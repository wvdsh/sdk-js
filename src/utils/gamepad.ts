/**
 * Gamepad suspension for overlays shown over a game.
 *
 * The Gamepad API isn't focus-scoped, so a game polling navigator.getGamepads()
 * keeps reacting to presses meant for a host overlay. Suspending shims
 * getGamepads to report no gamepads; call the returned dispose fn to restore.
 */

// Ref-counted so overlapping suspensions don't restore early.
let depth = 0;
// Whatever was installed at suspend time (native, or the play shell's virtual gamepad shim).
let previousDescriptor: PropertyDescriptor | undefined;

export function suspendGamepads(): () => void {
  if (typeof navigator === "undefined" || !navigator.getGamepads)
    return () => {};

  if (++depth === 1) {
    previousDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "getGamepads"
    );
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: (): (Gamepad | null)[] => []
    });
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--depth === 0) {
      if (previousDescriptor) {
        Object.defineProperty(navigator, "getGamepads", previousDescriptor);
      } else {
        Reflect.deleteProperty(navigator, "getGamepads");
      }
      previousDescriptor = undefined;
    }
  };
}
