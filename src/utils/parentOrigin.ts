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
