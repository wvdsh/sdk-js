/**
 * Remote file storage service
 *
 * Exposes a specific remote folder for the game to save user-specific files to.
 * TODO: Extend this to game-level assets as well.
 */

import type { WavedashResponse, RemoteFileMetadata } from "../types";
import type { WavedashSDK } from "../index";
import * as indexedDBUtils from "../utils/indexedDB";
import { api } from "@wvdsh/types";

let REMOTE_STORAGE_ORIGIN: string | undefined;

// TODO: Should storage folder be configurable?
const REMOTE_STORAGE_FOLDER = "userfs";

function getRemoteStorageOrigin(this: WavedashSDK): string {
  if (REMOTE_STORAGE_ORIGIN) {
    return REMOTE_STORAGE_ORIGIN;
  }

  // If explicitly configured, use that
  if (this.config?.remoteStorageOrigin) {
    REMOTE_STORAGE_ORIGIN = this.config.remoteStorageOrigin;
    return REMOTE_STORAGE_ORIGIN;
  }

  // Fallback to ugc.hostname if running in browser
  if (typeof window !== "undefined" && window.location) {
    const hostname = window.location.hostname;
    const parts = hostname.split(".");
    REMOTE_STORAGE_ORIGIN =
      `${window.location.protocol}//ugc.` + parts.slice(2).join(".");
    return REMOTE_STORAGE_ORIGIN;
  }

  throw new Error("Remote storage origin cannot be determined.");
}

function getRemoteStorageUrl(this: WavedashSDK, filePath: string): string {
  const ORIGIN = getRemoteStorageOrigin.call(this);
  const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
  return `${ORIGIN}/${this.gameCloudId}/${REMOTE_STORAGE_FOLDER}/${this.wavedashUser.id}/${relativePath}`;
}

async function uploadFromIndexedDb(
  this: WavedashSDK,
  presignedUploadUrl: string,
  indexedDBKey: string
): Promise<boolean> {
  try {
    // TODO: Copying Godot's convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
    const record = await indexedDBUtils.getRecordFromIndexedDB(
      "/userfs",
      "FILE_DATA",
      indexedDBKey
    );
    if (!record) {
      this.logger.error(`File not found in IndexedDB: ${indexedDBKey}`);
      return false;
    }
    const blob = indexedDBUtils.toBlobFromIndexedDBValue(record);
    const response = await fetch(presignedUploadUrl, {
      method: "PUT",
      body: blob
      // credentials not needed for presigned upload URL
    });
    return response.ok;
  } catch (error) {
    this.logger.error(`Error uploading from IndexedDB: ${error}`);
    return false;
  }
}

async function uploadFromFS(
  this: WavedashSDK,
  presignedUploadUrl: string,
  filePath: string
): Promise<boolean> {
  try {
    const exists = this.engineInstance!.FS.analyzePath(filePath).exists;
    if (!exists) {
      throw new Error(`File not found in FS: ${filePath}`);
    }
    const data = this.engineInstance!.FS.readFile(
      filePath
    ) as Uint8Array<ArrayBuffer>;
    // Convert to Blob for Safari compatibility
    const blob = new Blob([data], { type: "application/octet-stream" });
    const response = await fetch(presignedUploadUrl, {
      method: "PUT",
      body: blob
      // credentials not needed for presigned upload URL
    });
    return response.ok;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    this.logger.error(`Error uploading from FS: ${msg}`);
    return false;
  }
}

// Helper to upload a local file to remote storage
export async function upload(
  this: WavedashSDK,
  presignedUploadUrl: string,
  filePath: string
): Promise<boolean> {
  this.logger.debug(`Uploading ${filePath} to: ${presignedUploadUrl}`);
  if (this.engineInstance && !this.engineInstance.FS) {
    this.logger.error("Engine instance is missing the Emscripten FS API");
    return false;
  }
  let success = false;

  if (this.engineInstance) {
    success = await uploadFromFS.call(this, presignedUploadUrl, filePath);
  } else {
    success = await uploadFromIndexedDb.call(
      this,
      presignedUploadUrl,
      filePath
    );
  }
  return success;
}

// Helper to save a remote file locally
export async function download(
  this: WavedashSDK,
  url: string,
  filePath: string
): Promise<boolean> {
  this.logger.debug(`Downloading ${filePath} from: ${url}`);
  if (this.engineInstance && !this.engineInstance.FS) {
    this.logger.error("Engine instance is missing the Emscripten FS API");
    return false;
  }

  const response = await fetch(url, {
    credentials: "include",
    method: "GET"
  });
  if (!response.ok) {
    this.logger.error(
      `Failed to download remote file: ${response.status} (${response.statusText})`
    );
    return false;
  }

  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const dataArray = new Uint8Array(arrayBuffer);

  try {
    if (this.engineInstance) {
      // Save to engine filesystem
      // Create intermediate directory tree if necessary
      const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dirPath) {
        try {
          this.engineInstance.FS.mkdirTree(dirPath);
        } catch (_error) {
          // Directory might already exist, which is fine
        }
      }
      this.engineInstance.FS.writeFile(filePath, dataArray);
    } else {
      // Save directly to IndexedDB for non-engine contexts
      // TODO: Just copying the Godot convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
      await indexedDBUtils.writeToIndexedDB(
        "/userfs",
        "FILE_DATA",
        filePath,
        dataArray
      );
    }
    this.logger.debug(`Successfully saved to: ${filePath}`);
    return true;
  } catch (error) {
    this.logger.error(
      `Failed to save file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Uploads a local file to remote storage
 * @param this - WavedashSDK instance
 * @param filePath - The path of the local file to upload
 * @param uploadTo - Optionally provide a path to upload the file to, defaults to the same path as the local file
 * @returns The path of the remote file that the local file was uploaded to
 */
export async function uploadRemoteFile(
  this: WavedashSDK,
  filePath: string
): Promise<WavedashResponse<string>> {
  const args = { filePath };

  try {
    const uploadUrl = await this.convexClient.mutation(
      api.sdk.remoteFileStorage.getUploadUrl,
      { path: args.filePath }
    );
    const success = await upload.call(this, uploadUrl, args.filePath);
    return {
      success: success,
      data: args.filePath,
      args: args
    };
  } catch (error) {
    this.logger.error(`Failed to upload remote file: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Downloads a remote file to a local location
 * @param this - WavedashSDK instance
 * @param filePath - The path of the remote file to download
 * @param downloadTo - Optionally provide a path to download the file to, defaults to the same path as the remote file
 * @returns The path of the local file that the remote file was downloaded to
 */
export async function downloadRemoteFile(
  this: WavedashSDK,
  filePath: string
): Promise<WavedashResponse<string>> {
  const args = { filePath };

  try {
    const url = getRemoteStorageUrl.call(this, args.filePath);
    const success = await download.call(this, url, args.filePath);
    return {
      success: success,
      data: args.filePath,
      args: args
    };
  } catch (error) {
    this.logger.error(`Failed to download remote file: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Lists each file in a remote directory, including its subdirectories
 * Returns only file paths, no directory paths
 * @param this - WavedashSDK instance
 * @param path - The path of the remote directory to list
 * @returns A list of metadata for each file in the remote directory
 */
export async function listRemoteDirectory(
  this: WavedashSDK,
  path: string
): Promise<WavedashResponse<RemoteFileMetadata[]>> {
  const args = { path };

  try {
    const url = getRemoteStorageUrl.call(this, path) + "?list=true";
    const response = await fetch(url, {
      credentials: "include",
      method: "GET"
    });
    if (!response.ok) {
      throw new Error(`${response.status} (${response.statusText})`);
    }
    const responseJson = await response.json();
    const files = responseJson.files.filter(
      (file: RemoteFileMetadata) => !file.key.endsWith("/")
    );
    return {
      success: true,
      data: files,
      args: args
    };
  } catch (error) {
    this.logger.error(`Failed to list directory: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function downloadRemoteDirectory(
  this: WavedashSDK,
  path: string
): Promise<WavedashResponse<string>> {
  const args = { path };

  try {
    const normalizedPath = path.endsWith("/") ? path : path + "/";
    const response = await listRemoteDirectory.call(this, args.path);
    if (!response.success) {
      throw new Error(response.message);
    }
    const files = response.data as RemoteFileMetadata[];
    // Download all files in parallel since thread support is enabled
    // Subdirectories will be created recursively if needed
    const downloadPromises = files.map(async (file) => {
      const url = getRemoteStorageUrl.call(this, normalizedPath + file.name);
      const success = await download.call(
        this,
        url,
        normalizedPath + file.name
      );
      return { fileName: file.name, success };
    });

    const downloadResults = await Promise.all(downloadPromises);

    // Check if any downloads failed
    const failedDownloads = downloadResults.filter((result) => !result.success);
    if (failedDownloads.length > 0) {
      throw new Error(
        `Failed to download ${failedDownloads.length} files: ${failedDownloads.map((f) => f.fileName).join(", ")}`
      );
    }
    return {
      success: true,
      data: normalizedPath,
      args: args
    };
  } catch (error) {
    this.logger.error(`Failed to download user directory: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
