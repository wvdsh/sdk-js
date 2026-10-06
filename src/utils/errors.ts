import { ConvexError } from "convex/values";

/**
 * Human-readable message for an error, preferring a ConvexError's payload.
 *
 * Production Convex deployments redact server error messages to
 * "[CONVEX M(fn)] [Request ID: ...] Server Error", so `error.message` never
 * contains what the backend threw. The ConvexError payload survives: either
 * the thrown string, or an object like `{ code, message }`.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string") return data;
    if (
      data &&
      typeof data === "object" &&
      "message" in data &&
      typeof data.message === "string"
    ) {
      return data.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
