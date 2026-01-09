/**
 * Derive parent origin from iframe URL pattern.
 * iframe: [gameSlug].builds.[parentDomain] or [gameSlug].sandbox.[parentDomain]
 * parent: [parentDomain]
 */
function deriveParentOrigin(): string {
  if (typeof window === "undefined") return "";
  const iframeHost = window.location.hostname;
  const match = iframeHost.match(/^[\w-]+\.(builds|sandbox)\.(.+)$/);
  if (match) {
    const parentDomain = match[2];
    return `${window.location.protocol}//${parentDomain}`;
  }
  console.error(`Invalid iframe hostname pattern: ${iframeHost}`);
  return "";
}

export const parentOrigin = deriveParentOrigin();
