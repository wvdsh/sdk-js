/**
 * Utilities for sending beacons to the parent domain.
 * Uses navigator.sendBeacon for reliable fire-and-forget during page unload.
 */

import { parentOrigin } from "./parentOrigin";

/**
 * Send a beacon to the parent domain.
 * Note: Uses text/plain to avoid CORS preflight on cross-origin requests.
 */
export function sendBeacon(path: string, data: Record<string, unknown>): boolean {
    if (typeof navigator === "undefined" || !parentOrigin) {
        return false;
    }
    const url = `${parentOrigin}${path}`;
    const blob = new Blob([JSON.stringify(data)], { type: "text/plain" });
    return navigator.sendBeacon(url, blob);
}
