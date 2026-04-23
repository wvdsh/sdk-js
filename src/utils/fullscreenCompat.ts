import { FullscreenManager } from "../services/fullscreen";

/**
 * Monkey-patch the browser's native fullscreen API so legacy games — ones that
 * call `element.requestFullscreen()` or listen for `fullscreenchange` directly
 * — end up driving Wavedash's fullscreen instead of the iframe's own. The
 * iframe doesn't have the `allow="fullscreen"` permission anymore, so without
 * these shims those calls would silently reject.
 *
 * The shim:
 *   - Routes `Element.prototype.requestFullscreen` and the webkit-prefixed
 *     variant to `manager.requestFullscreen()`.
 *   - Routes `Document.prototype.exitFullscreen` (and webkit variant) to
 *     `manager.exitFullscreen()`.
 *   - Rewrites `document.fullscreenElement` / `webkitFullscreenElement` to
 *     reflect our state instead of the iframe's native state.
 *   - Fires a synthetic `fullscreenchange` (and `webkitfullscreenchange`)
 *     event on the document whenever the parent reports a state flip.
 *
 * The original native fullscreen never runs on anything inside the iframe,
 * because the iframe is no longer granted the fullscreen feature policy.
 */
export function installFullscreenCompat(manager: FullscreenManager): void {
  if (typeof document === "undefined") return;

  // Drive reads: many games read `document.fullscreenElement` to figure out
  // whether they're fullscreen. We expose `document.body` when the parent has
  // us fullscreen, so truthy checks keep working.
  const fullscreenElementGetter = () =>
    manager.isFullscreen() ? document.body : null;

  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    get: fullscreenElementGetter
  });
  Object.defineProperty(document, "webkitFullscreenElement", {
    configurable: true,
    get: fullscreenElementGetter
  });

  // Drive writes: requestFullscreen enters, exitFullscreen exits. Both return
  // a Promise to match the native signature; games that `await` them still
  // get sensible behavior (we resolve on the next parent-reported state flip).
  const enter = (): Promise<void> => {
    if (manager.isFullscreen()) return Promise.resolve();
    manager.requestFullscreen(true);
    return waitForState(manager, true);
  };
  const exit = (): Promise<void> => {
    if (!manager.isFullscreen()) return Promise.resolve();
    manager.requestFullscreen(false);
    return waitForState(manager, false);
  };

  Element.prototype.requestFullscreen = function () {
    return enter();
  };
  // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
  Element.prototype.webkitRequestFullscreen = function () {
    return enter();
  };

  Document.prototype.exitFullscreen = function () {
    return exit();
  };
  // @ts-expect-error webkit-prefixed is not in lib.dom.d.ts
  Document.prototype.webkitExitFullscreen = function () {
    return exit();
  };

  // Fan state changes out as synthetic events so listeners on `document`
  // ("fullscreenchange", "webkitfullscreenchange") fire exactly once per flip.
  manager.subscribe(() => {
    document.dispatchEvent(new Event("fullscreenchange"));
    document.dispatchEvent(new Event("webkitfullscreenchange"));
  });
}

function waitForState(
  manager: FullscreenManager,
  target: boolean
): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = manager.subscribe((isFullscreen) => {
      if (isFullscreen === target) {
        unsubscribe();
        resolve();
      }
    });
  });
}
