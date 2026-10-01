import { logger } from "./logger";

/**
 * Decode a gameplay JWT payload to read its claims. We
 * don't verify the signature here — a hostile client can patch this function
 * to return whatever it wants either way, so verifying locally adds bar but
 * no real boundary. The play worker re-verifies the JWT signature on every
 * paid-asset request — that's the actual security gate.
 *
 * UTF-8 safe: claims may carry arbitrary user/file paths (e.g. r2key).
 */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  try {
    const [, payloadB64] = jwt.split(".");
    if (!payloadB64) return null;
    const b64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "===".slice((b64.length + 3) % 4);
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Record<string, unknown>;
  } catch (err) {
    logger.warn("Failed to decode JWT payload", err);
    return null;
  }
}

/**
 * One claim from a gameplay JWT's payload, or undefined when it's missing.
 */
export function readJwtClaim<T>(jwt: string, claim: string): T | undefined {
  return decodeJwtPayload(jwt)?.[claim] as T | undefined;
}
