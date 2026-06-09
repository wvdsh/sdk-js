/**
 * Pointer lock suspension for overlays shown over a game.
 *
 * A game that re-requests pointer lock every frame would steal the cursor back
 * from an overlay. Suspending shims requestPointerLock
 * to a no-op so those calls can't reacquire the lock, and exits any active lock.
 * Call the returned dispose fn to restore the native method.
 */

const hasDom = typeof Element !== "undefined" && typeof document !== "undefined";
// Captured at module load, before anything could have replaced it.
const nativeRequestPointerLock = hasDom ? Element.prototype.requestPointerLock : undefined;

// Ref-counted so overlapping suspensions don't restore the native method early.
let depth = 0;

export function suspendPointerLock(): () => void {
  if (!hasDom || !nativeRequestPointerLock) return () => {};

  if (++depth === 1) {
    // Resolved promise keeps modern (Promise-returning) callers happy; legacy
    // void callers ignore the return value.
    Element.prototype.requestPointerLock = function () {
      return Promise.resolve();
    } as typeof Element.prototype.requestPointerLock;
  }
  document.exitPointerLock();

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--depth === 0) Element.prototype.requestPointerLock = nativeRequestPointerLock;
  };
}
