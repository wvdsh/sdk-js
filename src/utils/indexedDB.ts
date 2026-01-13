/**
 * Utility functions to interact with IndexedDB
 */

// IndexedDB can return various shapes depending on how data was stored
type IndexedDBValue =
  | { contents: ArrayBuffer | Uint8Array | Int8Array }
  | { data: ArrayBuffer }
  | { blob: Blob }
  | Blob
  | ArrayBuffer
  | Uint8Array
  | Int8Array;

// Non-engine local storage (mirrors Godot IDBFS conventions for table names)
const LOCAL_STORAGE_DB_NAME = "/userfs";
const LOCAL_STORAGE_STORE_NAME = "FILE_DATA";

export async function writeToIndexedDB(
  key: string,
  data: Uint8Array
): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(LOCAL_STORAGE_DB_NAME);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () =>
      reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(LOCAL_STORAGE_STORE_NAME, "readwrite");
      const store = tx.objectStore(LOCAL_STORAGE_STORE_NAME);

      // Store raw data as a file with timestamp and file "mode"
      const value = {
        contents: data,
        timestamp: Date.now(),
        mode: 33206 // Standard file permissions (rw-rw-rw-)
      };

      const putReq = store.put(value, key);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

export async function getRecordFromIndexedDB(
  key: string
): Promise<IndexedDBValue | null> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(LOCAL_STORAGE_DB_NAME);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () =>
      reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(LOCAL_STORAGE_STORE_NAME, "readonly");
      const store = tx.objectStore(LOCAL_STORAGE_STORE_NAME);
      const getReq = store.get(key);
      getReq.onsuccess = () => resolve(getReq.result);
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

export function toBlobFromIndexedDBValue(value: IndexedDBValue): Blob {
  if (value == null) throw new Error("File not found in IndexedDB");
  // Common IDBFS shapes:
  // - { contents: ArrayBuffer } or { contents: Uint8Array } or { contents: Int8Array }
  // - Blob
  // - ArrayBuffer / Uint8Array / Int8Array
  if ("contents" in value && value.contents != null) {
    const buf =
      value.contents instanceof Uint8Array ||
      value.contents instanceof Int8Array
        ? value.contents
        : new Uint8Array(value.contents);
    return new Blob([buf as BlobPart], { type: "application/octet-stream" });
  }
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array || value instanceof Int8Array)
    return new Blob([value as unknown as BlobPart], {
      type: "application/octet-stream"
    });
  if (value instanceof ArrayBuffer)
    return new Blob([value], { type: "application/octet-stream" });
  // Fallback for shapes like { data: ArrayBuffer } or { blob: Blob }
  if ("data" in value && value.data instanceof ArrayBuffer)
    return new Blob([value.data], { type: "application/octet-stream" });
  if ("blob" in value && value.blob instanceof Blob) return value.blob;
  throw new Error("Unrecognized value shape from IndexedDB");
}
