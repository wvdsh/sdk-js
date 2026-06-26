/**
 * Parent (mainsite) origin used by iframeMessenger for postMessage targeting
 * and incoming-message origin validation. Set once from SDKConfig.parentOrigin
 * during setupWavedashSDK() bootstrap — must be passed explicitly because the
 * play iframe can live on a different TLD than the mainsite, so it can't be
 * derived from the iframe hostname.
 */
let _parentOrigin = "";

export function setParentOrigin(origin: string): void {
  _parentOrigin = origin;
}

export function getParentOrigin(): string {
  return _parentOrigin;
}

/**
 * False in standalone contexts like `wavedash dev`, where the game runs
 * top-level and SDKConfig.parentOrigin is "". Parent-required calls gate on
 * this so they fail fast or imitate locally instead of hanging on a reply that
 * never arrives.
 */
export function hasParentFrame(): boolean {
  return _parentOrigin !== "";
}
