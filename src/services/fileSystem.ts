/**
 * File system service
 * Utilities for syncing local IndexedDB files with remote storage.
 *
 * Exposes a specific remote folder for the game to save user-specific files to.
 * TODO: Extend this to game-level assets as well.
 */

import type { RemoteFileMetadata } from "../types";
import type { WavedashSDK } from "../index";
import * as indexedDBUtils from "../utils/indexedDB";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { api } from "@wvdsh/api";

// Name of the remote R2 folder that stores user files
// TODO: Should storage folder be configurable?
const REMOTE_STORAGE_FOLDER = "userfs";

// Stable path used as the remote key prefix, replacing the per-build Unity persistentDataPath
const WAVEDASH_PERSISTENT_DATA_PATH = "/idbfs/wavedash";

export class FileSystemManager extends WavedashManager {
  private remoteStorageOrigin: string | undefined;

  constructor(sdk: WavedashSDK) {
    super(sdk);
  }

  /**
   * Converts a local filesystem path into a full R2 object key.
   * Normalizes the Unity persistentDataPath and prepends the R2 prefix.
   */
  private toRemoteKey(localPath: string): string {
    const unityPersistentDataPath =
      this.sdk.engineInstance?.unityPersistentDataPath;
    const normalized = unityPersistentDataPath
      ? localPath.replace(
          unityPersistentDataPath,
          WAVEDASH_PERSISTENT_DATA_PATH
        )
      : localPath;
    const relative = normalized.startsWith("/")
      ? normalized.slice(1)
      : normalized;
    return `${this.sdk.gameCloudId}/${REMOTE_STORAGE_FOLDER}/${this.sdk.wavedashUser.id}/${relative}`;
  }

  /**
   * Converts a full R2 object key back into the local filesystem path
   * the engine expects. Inverse of toRemoteKey.
   */
  private toLocalPath(r2Key: string): string {
    const prefix = `${this.sdk.gameCloudId}/${REMOTE_STORAGE_FOLDER}/${this.sdk.wavedashUser.id}/`;
    const stripped = r2Key.startsWith(prefix)
      ? "/" + r2Key.slice(prefix.length)
      : r2Key;
    const unityPersistentDataPath =
      this.sdk.engineInstance?.unityPersistentDataPath;
    return unityPersistentDataPath
      ? stripped.replace(WAVEDASH_PERSISTENT_DATA_PATH, unityPersistentDataPath)
      : stripped;
  }

  // ================
  // Public Methods
  // ================

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(filePath: string): Promise<string> {
    const uploadUrl = await this.sdk.convexClient.mutation(
      api.sdk.remoteFileStorage.getUploadUrl,
      { path: this.toRemoteKey(filePath) }
    );
    const success = await this.upload(uploadUrl, filePath);
    if (!success) {
      throw new Error(`Failed to upload file: ${filePath}`);
    }
    return filePath;
  }

  /**
   * Deletes a remote file from storage
   * @param filePath - The path of the remote file to delete
   * @returns The path of the remote file that was deleted
   */
  async deleteRemoteFile(filePath: string): Promise<string> {
    const url = this.getRemoteStorageUrl(filePath);
    const jwt = await this.sdk.ensureGameplayJwt();
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    });
    if (!response.ok) {
      const msg = `Failed to delete remote file ${filePath}: ${response.status} (${response.statusText})`;
      logger.error(msg);
      throw new Error(msg);
    }
    return filePath;
  }

  /**
   * Downloads a remote file to a local location.
   * Throws on failure; the error message is the server's HTTP status (e.g. "404 (Not Found)")
   * or a network-level description if the server didn't respond. See also: {@link remoteFileExists}
   * @param filePath - The path of the remote file to download
   * @returns The path of the local file that the remote file was downloaded to
   */
  async downloadRemoteFile(filePath: string): Promise<string> {
    const url = this.getRemoteStorageUrl(filePath);
    await this.download(url, filePath);
    return filePath;
  }

  /**
   * Checks whether a remote file exists by issuing a HEAD request.
   * Does NOT throw for the "file does not exist" case — returns false.
   * Throws only for real errors (network failure, auth failure, server error).
   * @param filePath - The path of the remote file to check
   * @returns true if the remote file exists, false otherwise
   */
  async remoteFileExists(filePath: string): Promise<boolean> {
    const url = this.getRemoteStorageUrl(filePath);
    const jwt = await this.sdk.ensureGameplayJwt();
    const response = await fetch(url, {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw new Error(`${response.status} (${response.statusText})`);
  }

  /**
   * Lists each file in a remote directory, including its subdirectories.
   * Returns only file paths, no directory paths.
   * An empty or non-existent directory returns an empty array — not an error.
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(path: string): Promise<RemoteFileMetadata[]> {
    const url = this.getRemoteStorageUrl(path) + "?list=true";
    const jwt = await this.sdk.ensureGameplayJwt();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    });
    // UGC host returns 200 with an empty `.files` array. Older deployments
    // (and any rollout skew) returned 404 — treat both as "no files," not an error.
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(`${response.status} (${response.statusText})`);
    }
    const responseJson = await response.json();
    return responseJson.files
      .filter((file: RemoteFileMetadata) => !file.key.endsWith("/"))
      .map((file: RemoteFileMetadata) => ({
        ...file,
        key: this.toLocalPath(file.key)
      }));
  }

  async downloadRemoteDirectory(path: string): Promise<string> {
    const files = await this.listRemoteDirectory(path);

    const downloadPromises = files.map(async (file) => {
      const url = this.getRemoteStorageUrl(file.key);
      try {
        await this.download(url, file.key);
        return { fileName: file.name, success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to download ${file.name}: ${message}`);
        return { fileName: file.name, success: false };
      }
    });

    const downloadResults = await Promise.all(downloadPromises);
    const failedDownloads = downloadResults.filter((result) => !result.success);
    if (failedDownloads.length > 0) {
      throw new Error(
        `Failed to download ${failedDownloads.length} files: ${failedDownloads.map((f) => f.fileName).join(", ")}`
      );
    }
    return path;
  }

  async writeLocalFile(filePath: string, data: Uint8Array): Promise<boolean> {
    logger.debug(`Writing local file: ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      logger.error(
        `${this.sdk.engineInstance.type} engine detected, use engine's builtin file access to save files.`
      );
      return false;
    }

    try {
      await indexedDBUtils.writeToIndexedDB(filePath, data);
      return true;
    } catch (error) {
      logger.error(`Failed to write local file: ${error}`);
      return false;
    }
  }

  async readLocalFile(filePath: string): Promise<Uint8Array | null> {
    logger.debug(`Reading local file: ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      logger.error(
        `${this.sdk.engineInstance.type} engine detected, use engine's builtin file access to read files.`
      );
      return null;
    }
    try {
      const blob = await this.readLocalFileBlob(filePath);
      if (!blob) return null;
      const arrayBuffer = await blob.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    } catch (error) {
      logger.error(`Failed to read local file: ${error}`);
      return null;
    }
  }

  // ================
  // Internal Methods (used by other services like UGC)
  // ================

  // Helper to upload a local file to a presigned URL
  async upload(presignedUploadUrl: string, filePath: string): Promise<boolean> {
    logger.debug(`Uploading ${filePath} to: ${presignedUploadUrl}`);
    if (this.sdk.engineInstance && !this.sdk.engineInstance.FS) {
      logger.error("Engine instance is missing the Emscripten FS API");
      return false;
    }
    let success = false;

    if (this.sdk.engineInstance) {
      success = await this.uploadFromFS(presignedUploadUrl, filePath);
    } else {
      success = await this.uploadFromIndexedDb(presignedUploadUrl, filePath);
    }
    return success;
  }

  // Helper to download a file from a URL and save locally.
  // Throws on any failure with a message containing the HTTP status (e.g.
  // "404 (Not Found)") for server-side failures, or a network/FS error
  // description otherwise. Callers should let the error propagate; the
  // public apiCall wrapper surfaces the message in WavedashResponse.message.
  async download(url: string, filePath: string): Promise<void> {
    logger.debug(`Downloading ${filePath} from: ${url}`);
    if (this.sdk.engineInstance && !this.sdk.engineInstance.FS) {
      throw new Error("Engine instance is missing the Emscripten FS API");
    }

    const jwt = await this.sdk.ensureGameplayJwt();
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`
      }
    });
    if (!response.ok) {
      throw new Error(`${response.status} (${response.statusText})`);
    }

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const dataArray = new Uint8Array(arrayBuffer);

    if (this.sdk.engineInstance) {
      // Save to engine filesystem
      // Create intermediate directory tree if necessary
      const dirPath = filePath.substring(0, filePath.lastIndexOf("/"));
      if (dirPath) {
        try {
          this.sdk.engineInstance.FS.mkdirTree(dirPath);
        } catch (_error) {
          // Directory might already exist, which is fine
        }
      }
      try {
        this.sdk.engineInstance.FS.writeFile(filePath, dataArray);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to save file ${filePath} to engine FS: ${msg}`);
      }
    } else {
      // Save directly to IndexedDB for non-engine contexts
      const success = await this.writeLocalFile(filePath, dataArray);
      if (!success) {
        throw new Error(
          `Failed to save file ${filePath} to local IndexedDB storage`
        );
      }
    }
    logger.debug(`Successfully saved to: ${filePath}`);
  }

  // ================
  // Private Methods
  // ================

  private getRemoteStorageOrigin(): string {
    if (this.remoteStorageOrigin) {
      return this.remoteStorageOrigin;
    }

    // If explicitly configured, use that
    if (this.sdk.config?.remoteStorageOrigin) {
      this.remoteStorageOrigin = this.sdk.config.remoteStorageOrigin;
      return this.remoteStorageOrigin;
    }

    if (this.sdk.ugcHost) {
      this.remoteStorageOrigin = this.sdk.ugcHost.startsWith("http")
        ? this.sdk.ugcHost
        : `https://${this.sdk.ugcHost}`;
      return this.remoteStorageOrigin;
    }

    // Fallback to ugc.hostname if running in browser
    if (typeof window !== "undefined" && window.location) {
      const hostname = window.location.hostname;
      const parts = hostname.split(".");
      this.remoteStorageOrigin =
        `${window.location.protocol}//ugc.` + parts.slice(2).join(".");
      return this.remoteStorageOrigin;
    }

    throw new Error("Remote storage origin cannot be determined.");
  }

  private getRemoteStorageUrl(localPath: string): string {
    const origin = this.getRemoteStorageOrigin();
    return `${origin}/${this.toRemoteKey(localPath)}`;
  }

  private async uploadFromIndexedDb(
    presignedUploadUrl: string,
    indexedDBKey: string
  ): Promise<boolean> {
    try {
      const blob = await this.readLocalFileBlob(indexedDBKey);
      if (!blob) {
        logger.error(`File not found in IndexedDB: ${indexedDBKey}`);
        return false;
      }
      const response = await fetch(presignedUploadUrl, {
        method: "PUT",
        body: blob
        // credentials not needed for presigned upload URL
      });
      return response.ok;
    } catch (error) {
      logger.error(`Error uploading from IndexedDB: ${error}`);
      return false;
    }
  }

  private async uploadFromFS(
    presignedUploadUrl: string,
    filePath: string
  ): Promise<boolean> {
    try {
      const exists = this.sdk.engineInstance!.FS.analyzePath(filePath).exists;
      if (!exists) {
        throw new Error(`File not found in FS: ${filePath}`);
      }
      const data = this.sdk.engineInstance!.FS.readFile(
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
      logger.error(`Error uploading from FS: ${msg}`);
      return false;
    }
  }

  private async readLocalFileBlob(filePath: string): Promise<Blob | null> {
    logger.debug(`Reading local file (blob): ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      logger.error(
        `${this.sdk.engineInstance.type} engine detected, use engine's builtin file access to read files.`
      );
      return null;
    }

    try {
      const record = await indexedDBUtils.getRecordFromIndexedDB(filePath);
      if (!record) return null;

      return indexedDBUtils.toBlobFromIndexedDBValue(record);
    } catch (error) {
      logger.error(`Failed to read local file blob: ${error}`);
      return null;
    }
  }
}
