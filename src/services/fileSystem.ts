/**
 * File system service
 * Utilities for syncing local IndexedDB files with remote storage.
 *
 * Exposes a specific remote folder for the game to save user-specific files to.
 * TODO: Extend this to game-level assets as well.
 */

import type { WavedashResponse, RemoteFileMetadata } from "../types";
import type { WavedashSDK } from "../index";
import * as indexedDBUtils from "../utils/indexedDB";
import { api } from "@wvdsh/types";

// Name of the remote R2 folder that stores user files
// TODO: Should storage folder be configurable?
const REMOTE_STORAGE_FOLDER = "userfs";

export class FileSystemManager {
  private sdk: WavedashSDK;
  private remoteStorageOrigin: string | undefined;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ================
  // Public Methods
  // ================

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(filePath: string): Promise<WavedashResponse<string>> {
    const args = { filePath };

    try {
      const uploadUrl = await this.sdk.convexClient.mutation(
        api.sdk.remoteFileStorage.getUploadUrl,
        { path: args.filePath }
      );
      const success = await this.upload(uploadUrl, args.filePath);
      return {
        success: success,
        data: args.filePath,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Failed to upload remote file: ${error}`);
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
   * @param filePath - The path of the remote file to download
   * @returns The path of the local file that the remote file was downloaded to
   */
  async downloadRemoteFile(filePath: string): Promise<WavedashResponse<string>> {
    const args = { filePath };

    try {
      const url = this.getRemoteStorageUrl(args.filePath);
      const success = await this.download(url, args.filePath);
      return {
        success: success,
        data: args.filePath,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Failed to download remote file: ${error}`);
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
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(
    path: string
  ): Promise<WavedashResponse<RemoteFileMetadata[]>> {
    const args = { path };

    try {
      const url = this.getRemoteStorageUrl(path) + "?list=true";
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
      this.sdk.logger.error(`Failed to list directory: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async downloadRemoteDirectory(
    path: string
  ): Promise<WavedashResponse<string>> {
    const args = { path };

    try {
      const normalizedPath = path.endsWith("/") ? path : path + "/";
      const response = await this.listRemoteDirectory(args.path);
      if (!response.success) {
        throw new Error(response.message);
      }
      const files = response.data as RemoteFileMetadata[];
      // Download all files in parallel since thread support is enabled
      // Subdirectories will be created recursively if needed
      const downloadPromises = files.map(async (file) => {
        const url = this.getRemoteStorageUrl(normalizedPath + file.name);
        const success = await this.download(url, normalizedPath + file.name);
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
      this.sdk.logger.error(`Failed to download user directory: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async writeLocalFile(filePath: string, data: Uint8Array): Promise<boolean> {
    this.sdk.logger.debug(`Writing local file: ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      this.sdk.logger.error(
        `${this.sdk.engineInstance.type} engine detected, use engine's builtin file access to save files.`
      );
      return false;
    }

    try {
      await indexedDBUtils.writeToIndexedDB(filePath, data);
      return true;
    } catch (error) {
      this.sdk.logger.error(`Failed to write local file: ${error}`);
      return false;
    }
  }

  async readLocalFile(filePath: string): Promise<Uint8Array | null> {
    this.sdk.logger.debug(`Reading local file: ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      this.sdk.logger.error(
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
      this.sdk.logger.error(`Failed to read local file: ${error}`);
      return null;
    }
  }

  // ================
  // Internal Methods (used by other services like UGC)
  // ================

  // Helper to upload a local file to a presigned URL
  async upload(presignedUploadUrl: string, filePath: string): Promise<boolean> {
    this.sdk.logger.debug(`Uploading ${filePath} to: ${presignedUploadUrl}`);
    if (this.sdk.engineInstance && !this.sdk.engineInstance.FS) {
      this.sdk.logger.error("Engine instance is missing the Emscripten FS API");
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

  // Helper to download a file from a URL and save locally
  async download(url: string, filePath: string): Promise<boolean> {
    this.sdk.logger.debug(`Downloading ${filePath} from: ${url}`);
    if (this.sdk.engineInstance && !this.sdk.engineInstance.FS) {
      this.sdk.logger.error("Engine instance is missing the Emscripten FS API");
      return false;
    }

    const response = await fetch(url, {
      credentials: "include",
      method: "GET"
    });
    if (!response.ok) {
      this.sdk.logger.error(
        `Failed to download remote file: ${response.status} (${response.statusText})`
      );
      return false;
    }

    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const dataArray = new Uint8Array(arrayBuffer);

    try {
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
        this.sdk.engineInstance.FS.writeFile(filePath, dataArray);
      } else {
        // Save directly to IndexedDB for non-engine contexts
        const success = await this.writeLocalFile(filePath, dataArray);
        if (!success) return false;
      }
      this.sdk.logger.debug(`Successfully saved to: ${filePath}`);
      return true;
    } catch (error) {
      this.sdk.logger.error(
        `Failed to save file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
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

  private getRemoteStorageUrl(filePath: string): string {
    const ORIGIN = this.getRemoteStorageOrigin();
    const relativePath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    return `${ORIGIN}/${this.sdk.gameCloudId}/${REMOTE_STORAGE_FOLDER}/${this.sdk.wavedashUser.id}/${relativePath}`;
  }

  private async uploadFromIndexedDb(
    presignedUploadUrl: string,
    indexedDBKey: string
  ): Promise<boolean> {
    try {
      const blob = await this.readLocalFileBlob(indexedDBKey);
      if (!blob) {
        this.sdk.logger.error(`File not found in IndexedDB: ${indexedDBKey}`);
        return false;
      }
      const response = await fetch(presignedUploadUrl, {
        method: "PUT",
        body: blob
        // credentials not needed for presigned upload URL
      });
      return response.ok;
    } catch (error) {
      this.sdk.logger.error(`Error uploading from IndexedDB: ${error}`);
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
      this.sdk.logger.error(`Error uploading from FS: ${msg}`);
      return false;
    }
  }

  private async readLocalFileBlob(filePath: string): Promise<Blob | null> {
    this.sdk.logger.debug(`Reading local file (blob): ${filePath}`);
    if (this.sdk.engineInstance?.FS) {
      this.sdk.logger.error(
        `${this.sdk.engineInstance.type} engine detected, use engine's builtin file access to read files.`
      );
      return null;
    }

    try {
      const record = await indexedDBUtils.getRecordFromIndexedDB(filePath);
      if (!record) return null;

      return indexedDBUtils.toBlobFromIndexedDBValue(record);
    } catch (error) {
      this.sdk.logger.error(`Failed to read local file blob: ${error}`);
      return null;
    }
  }
}
