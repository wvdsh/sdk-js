/**
 * Utility functions to interact with IndexedDB
 */


export async function writeToIndexedDB(dbName: string, storeName: string, key: string, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () => reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);

      // Store raw data as a file with timestamp and file "mode"
      const value = {
        contents: data,
        timestamp: Date.now(),
        mode: 33206  // Standard file permissions (rw-rw-rw-)
      };

      const putReq = store.put(value, key);
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => db.close();
    };
  });
}

export async function getRecordFromIndexedDB(dbName: string, storeName: string, key: string): Promise<Record<string, any> | null> {
  return new Promise((resolve, reject) => {
    const openReq = indexedDB.open(dbName);
    openReq.onerror = () => reject(openReq.error);
    openReq.onupgradeneeded = () => reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
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
    const buf = (value.contents instanceof Uint8Array || value.contents instanceof Int8Array)
      ? value.contents
      : new Uint8Array(value.contents);
    return new Blob([buf], { type: "application/octet-stream" });
  }
  if (value instanceof Blob) return value;
  if (value instanceof Uint8Array || value instanceof Int8Array) return new Blob([value], { type: "application/octet-stream" });
  if (value instanceof ArrayBuffer) return new Blob([value], { type: "application/octet-stream" });
  // Fallback for shapes like { data: ArrayBuffer } or { blob: Blob }
  if (value.data instanceof ArrayBuffer) return new Blob([value.data], { type: "application/octet-stream" });
  if (value.blob instanceof Blob) return value.blob;
  throw new Error("Unrecognized value shape from IndexedDB");
}