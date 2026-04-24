/**
 * Client-side argument validation for the Wavedash SDK.
 *
 * Runs *before* Convex queries/mutations are sent so that invalid inputs
 * surface a readable error in the game dev's browser console instead of being
 * masked as the generic Convex "Server Error" (which happens because Convex's
 * built-in ArgumentValidationError is not a ConvexError and gets stripped in
 * production deployments).
 *
 * Validators are small, composable functions. Each one takes a `path` string
 * used purely for error messages (e.g. `"createLobby.visibility"`).
 */

import type { Id } from "../types";

export type Validator<T = unknown> = (value: unknown, path: string) => T;

// Convex document IDs are base32-encoded strings 31-37 characters long.
// See https://docs.convex.dev/using/document-ids
const CONVEX_ID_REGEX = /^[0-9a-z]{31,37}$/;

export const vString: Validator<string> = (value, path) => {
  if (typeof value !== "string") {
    throw new Error(
      `${path}: expected string, got ${describeValue(value)}`
    );
  }
  return value;
};

export const vNumber: Validator<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `${path}: expected finite number, got ${describeValue(value)}`
    );
  }
  return value;
};

export const vBoolean: Validator<boolean> = (value, path) => {
  if (typeof value !== "boolean") {
    throw new Error(
      `${path}: expected boolean, got ${describeValue(value)}`
    );
  }
  return value;
};

export const vNull: Validator<null> = (value, path) => {
  if (value !== null) {
    throw new Error(`${path}: expected null, got ${describeValue(value)}`);
  }
  return null;
};

export const vUint8Array: Validator<Uint8Array> = (value, path) => {
  if (!(value instanceof Uint8Array)) {
    throw new Error(
      `${path}: expected Uint8Array, got ${describeValue(value)}`
    );
  }
  return value;
};

export const vRecord: Validator<Record<string, unknown>> = (value, path) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `${path}: expected plain object, got ${describeValue(value)}`
    );
  }
  return value as Record<string, unknown>;
};

/**
 * Validate a Convex document ID string.
 * Format check only (31-37 char lowercase base32); the actual table binding
 * is enforced server-side.
 */
export function vId<T extends string>(tableName: T): Validator<Id<T>> {
  return (value, path) => {
    if (typeof value !== "string" || !CONVEX_ID_REGEX.test(value)) {
      throw new Error(
        `${path}: expected Id<"${tableName}"> (base32 string, 31-37 chars), got ${describeValue(value)}`
      );
    }
    return value as Id<T>;
  };
}

/**
 * Validate that a value is one of the values of an `as const` enum object
 * (e.g. `LOBBY_VISIBILITY`, `UGC_TYPE`).
 */
export function vEnum<T extends Record<string, string | number>>(
  enumObject: T,
  enumName?: string
): Validator<T[keyof T]> {
  const validValues = Object.values(enumObject);
  return (value, path) => {
    if (!validValues.includes(value as T[keyof T])) {
      const labels = Object.entries(enumObject)
        .map(([key, val]) => `${JSON.stringify(val)} (${key})`)
        .join(", ");
      const label = enumName ? `${enumName} ` : "";
      throw new Error(
        `${path}: invalid ${label}value ${describeValue(value)}. Expected one of: ${labels}`
      );
    }
    return value as T[keyof T];
  };
}

/** Permits `undefined` in addition to whatever the inner validator accepts. */
export function vOptional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (value, path) => {
    if (value === undefined) return undefined;
    return inner(value, path);
  };
}

/** Accepts any of the provided validators (tries each in order). */
export function vUnion<T>(...variants: Validator<T>[]): Validator<T> {
  return (value, path) => {
    for (const variant of variants) {
      try {
        return variant(value, path);
      } catch {
        // try next variant
      }
    }
    throw new Error(
      `${path}: no variant matched, got ${describeValue(value)}`
    );
  };
}

/** Pair of `[argName, validator]` used by `validateArgs`. */
export type ArgSpec = readonly [name: string, validator: Validator<unknown>];

/**
 * Validate a list of positional arguments against their specs.
 * Throws on the first failure with a clear message including method + arg name.
 */
export function validateArgs(
  methodName: string,
  specs: readonly ArgSpec[],
  values: readonly unknown[]
): void {
  for (let i = 0; i < specs.length; i++) {
    const [argName, validator] = specs[i];
    validator(values[i], `${methodName}.${argName}`);
  }
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof Uint8Array) {
    return `Uint8Array(byteLength=${value.byteLength})`;
  }
  if (Array.isArray(value)) return `array(length=${value.length})`;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    return `${type} ${JSON.stringify(value)}`;
  }
  return type;
}
