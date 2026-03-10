/**
 * Derive parent origin from iframe URL pattern.
 * iframe: [gameSlug].(builds|sandbox|local).[parentDomain]
 * parent: [parentDomain]
 */
function deriveParentOrigin(): string {
  if (typeof window === "undefined") return "";
  const iframeHost = window.location.host;
  const match = iframeHost.match(/^[\w-]+\.(builds|local)\.(.+)$/);
  if (match) {
    const parentDomain = match[2];
    // Use document.referrer to get the parent's actual protocol and port.
    // The iframe can't infer these from its own URL, and they may differ in
    // local dev (e.g. HTTP parent on :5173, HTTPS iframe on :443).
    if (document.referrer) {
      try {
        const ref = new URL(document.referrer);
        const parentHostname = parentDomain.replace(/:\d+$/, "");
        if (ref.hostname === parentHostname) {
          return ref.origin;
        }
      } catch {
        // ignore invalid referrer
      }
    }
    return `${window.location.protocol}//${parentDomain}`;
  }
  console.error(`Invalid iframe hostname pattern: ${iframeHost}`);
  return "";
}

export const parentOrigin = deriveParentOrigin();
