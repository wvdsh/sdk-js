/**
 * Gamepad helpers.
 *
 * The Gamepad API has no events and isn't focus-scoped, so both reading input
 * (heartbeat activity detection) and hiding it (overlay suspension) go through
 * navigator.getGamepads() here.
 */

export const GAMEPAD_AXIS_DEADZONE = 0.2;

/**
 * True if any connected gamepad has a pressed button or an axis outside the
 * deadzone. Reads through whatever getGamepads is currently installed, so it
 * reports no activity while gamepads are suspended.
 */
export function hasGamepadActivity(
  deadzone: number = GAMEPAD_AXIS_DEADZONE
): boolean {
  if (typeof navigator === "undefined" || !navigator.getGamepads) return false;
  for (const pad of navigator.getGamepads()) {
    if (!pad) continue;
    if (pad.buttons.some((b) => b.pressed)) return true;
    if (pad.axes.some((a) => Math.abs(a) > deadzone)) return true;
  }
  return false;
}

/**
 * Gamepad suspension for overlays shown over a game.
 *
 * A game polling navigator.getGamepads() keeps reacting to presses meant for a
 * host overlay. Suspending shims getGamepads to report no gamepads; call the
 * returned dispose fn to restore. Note this also blinds hasGamepadActivity()
 * (and thus heartbeat's inactivity reset) for the duration.
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
