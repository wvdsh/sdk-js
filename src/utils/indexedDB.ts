/**
 * Utility functions to interact with IndexedDB
 */

// Game data database (follows Godot/Emscripten IDBFS convention)
export const GAME_DATA_DB = "/userfs";
export const GAME_DATA_STORE = "FILE_DATA";

// Storage identity database - tracks which user/game owns the local data
const STORAGE_IDENTITY_DB = "storage-identity";
const STORAGE_IDENTITY_STORE = "identity";
const STORAGE_IDENTITY_KEY = "current";

interface StorageIdentity {
  userId: string;
  gameCloudId: string;
}

/**
 * Get the stored storage identity (userId + gameCloudId) from IndexedDB
 */
async function getStorageIdentity(): Promise<StorageIdentity | null> {
  return new Promise((resolve) => {
    const openReq = indexedDB.open(STORAGE_IDENTITY_DB, 1);

    openReq.onerror = () => {
      console.warn("[WavedashJS] Failed to open identity DB:", openReq.error);
      resolve(null);
    };

    openReq.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORAGE_IDENTITY_STORE)) {
        db.createObjectStore(STORAGE_IDENTITY_STORE);
      }
    };

    openReq.onsuccess = () => {
      const db = openReq.result;
      try {
        const tx = db.transaction(STORAGE_IDENTITY_STORE, "readonly");
        const store = tx.objectStore(STORAGE_IDENTITY_STORE);
        const getReq = store.get(STORAGE_IDENTITY_KEY);

        getReq.onsuccess = () => resolve(getReq.result || null);
        getReq.onerror = () => {
          console.warn("[WavedashJS] Failed to get identity:", getReq.error);
          resolve(null);
        };
        tx.oncomplete = () => db.close();
      } catch (error) {
        console.warn("[WavedashJS] Failed to read identity:", error);
        db.close();
        resolve(null);
      }
    };
  });
}

/**
 * Store the storage identity (userId + gameCloudId) in IndexedDB
 */
async function setStorageIdentity(
  userId: string,
  gameCloudId: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(STORAGE_IDENTITY_DB, 1);

    openReq.onerror = () => reject(openReq.error);

    openReq.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORAGE_IDENTITY_STORE)) {
        db.createObjectStore(STORAGE_IDENTITY_STORE);
      }
    };

    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(STORAGE_IDENTITY_STORE, "readwrite");
      const store = tx.objectStore(STORAGE_IDENTITY_STORE);

      const identity: StorageIdentity = { userId, gameCloudId };
      const putReq = store.put(identity, STORAGE_IDENTITY_KEY);

      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

/**
 * Delete the game data IndexedDB database entirely
 */
export async function clearGameIndexedDB(): Promise<void> {
  return new Promise((resolve) => {
    const deleteReq = indexedDB.deleteDatabase(GAME_DATA_DB);

    deleteReq.onsuccess = () => {
      console.log("[WavedashJS] Cleared game IndexedDB");
      resolve();
    };

    deleteReq.onerror = () => {
      console.warn(
        "[WavedashJS] Failed to clear game IndexedDB:",
        deleteReq.error
      );
      // Resolve anyway - don't block SDK init
      resolve();
    };

    deleteReq.onblocked = () => {
      console.warn("[WavedashJS] IndexedDB deletion blocked (DB in use)");
      // Resolve anyway - the game hasn't started yet so this shouldn't happen
      resolve();
    };
  });
}

/**
 * Validate the stored context against current user/game and reset if needed.
 * Should be called before the game engine starts.
 *
 * @returns true if IndexedDB was cleared, false otherwise
 */
export async function resetStorageIfIdentityChanged(
  userId: string,
  gameCloudId: string
): Promise<boolean> {
  try {
    const storedIdentity = await getStorageIdentity();

    const identityMatches =
      storedIdentity &&
      storedIdentity.userId === userId &&
      storedIdentity.gameCloudId === gameCloudId;

    if (!identityMatches) {
      if (storedIdentity) {
        console.log(
          "[WavedashJS] User or game branch changed, clearing local IndexedDB",
          {
            previous: storedIdentity,
            current: { userId, gameCloudId },
          }
        );
      } else {
        console.log("[WavedashJS] No stored identity, initializing");
      }

      await clearGameIndexedDB();
      await setStorageIdentity(userId, gameCloudId);
      return storedIdentity !== null; // Only return true if we actually cleared existing data
    }

    return false;
  } catch (error) {
    console.warn("[WavedashJS] Storage identity validation failed:", error);
    // Don't block SDK init on error
    return false;
  }
}

export async function writeToIndexedDB(
  dbName: string,
  storeName: string,
  key: string,
  data: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () =>
      reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      // Store raw data as a file with timestamp and file "mode"
      const value = {
        contents: data,
        timestamp: Date.now(),
        mode: 33206, // Standard file permissions (rw-rw-rw-)
      };

      const putReq = store.put(value, key);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

export async function getRecordFromIndexedDB(
  dbName: string,
  storeName: string,
  key: string
): Promise<Record<string, any> | null> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () =>
      reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const getReq = store.get(key);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

export function toBlobFromIndexedDBValue(value: any): Blob {
  if (value == null) throw new Error("File not found in IndexedDB");
  // Common IDBFS shapes:
  // - { contents: ArrayBuffer } or { contents: Uint8Array } or { contents: Int8Array }
  // - Blob
  // - ArrayBuffer / Uint8Array / Int8Array
  if (value.contents != null) {
    const buf =
      value.contents instanceof Uint8Array ||
        value.contents instanceof Int8Array
        ? value.contents
        : new Uint8Array(value.contents);
    return new Blob([buf], { type: "application/octet-stream" });
  }
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array || value instanceof Int8Array)
    return new Blob([value as unknown as BlobPart], {
      type: "application/octet-stream",
    });
  if (value instanceof ArrayBuffer)
    return new Blob([value], { type: "application/octet-stream" });
  // Fallback for shapes like { data: ArrayBuffer } or { blob: Blob }
  if (value.data instanceof ArrayBuffer)
    return new Blob([value.data], { type: "application/octet-stream" });
  if (value.blob instanceof Blob) return value.blob;
  throw new Error("Unrecognized value shape from IndexedDB");
}
