/**
 * Remote file storage service
 * 
 * Exposes a specific remote folder for the game to save user-specific files to.
 * TODO: Extend this to game-level assets as well.
 */

import type {
  WavedashResponse
} from '../types';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';
import * as indexedDBUtils from '../utils/indexedDB';

let REMOTE_STORAGE_ORIGIN: string | undefined;

// TODO: Should storage folder be configurable?
const REMOTE_STORAGE_FOLDER = 'userfs';

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
  if (typeof window !== 'undefined' && window.location) {
    const hostname = window.location.hostname;
    const parts = hostname.split('.');
    REMOTE_STORAGE_ORIGIN = `${window.location.protocol}//ugc.` + parts.slice(1).join('.');
    return REMOTE_STORAGE_ORIGIN;
  }
  
  throw new Error('Remote storage origin cannot be determined.');
}

function getRemoteStorageUrl(this: WavedashSDK, filePath: string): string {
  const ORIGIN = getRemoteStorageOrigin.call(this);
  return `${ORIGIN}/${REMOTE_STORAGE_FOLDER}/${this.wavedashUser.id}/${filePath}`;
}

async function uploadFromIndexedDb(this: WavedashSDK, presignedUploadUrl: string, indexedDBKey: string): Promise<boolean> {
  try {
    // TODO: Copying Godot's convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
    const record = await indexedDBUtils.getRecordFromIndexedDB('/userfs', 'FILE_DATA', indexedDBKey);
    if (!record) {
      this.logger.error(`File not found in IndexedDB: ${indexedDBKey}`);
      return false;
    }
    const blob = indexedDBUtils.toBlobFromIndexedDBValue(record);
    const response = await fetch(presignedUploadUrl, {
      method: 'PUT',
      body: blob
      // credentials not needed for presigned upload URL
    });
    return response.ok;
  } catch (error) {
    this.logger.error(`Error uploading from IndexedDB: ${error}`);
    return false;
  }
}

async function uploadFromFS(this: WavedashSDK, presignedUploadUrl: string, filePath: string): Promise<boolean> {
  try {
    // const exists = this.engineInstance!.FS.analyzePath(filePath).exists;
    // if (!exists) {
    //   throw new Error(`File not found in FS: ${filePath}`);
    // }
    const blob = this.engineInstance!.FS.readFile(filePath) as Uint8Array;
    const response = await fetch(presignedUploadUrl, {
      method: 'PUT',
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
export async function upload(this: WavedashSDK, presignedUploadUrl: string, filePath: string): Promise<boolean> {
  this.logger.debug(`Uploading ${filePath} to: ${presignedUploadUrl}`);
  if (this.engineInstance && !this.engineInstance.FS) {
    throw new Error('Engine instance is missing the Emscripten FS API');
  }
  let success = false;

  if (this.engineInstance) {
    success = await uploadFromFS.call(this, presignedUploadUrl, filePath);
  }
  else {
    success = await uploadFromIndexedDb.call(this, presignedUploadUrl, filePath);
  }
  return success;
}

// Helper to save a remote file locally
export async function download(this: WavedashSDK, url: string, filePath: string): Promise<boolean> {
  this.logger.debug(`Downloading ${filePath} from: ${url}`);
  if (this.engineInstance && !this.engineInstance.FS) {
    throw new Error('Engine instance is missing the Emscripten FS API');
  }

  const response = await fetch(url, { 
    credentials: 'include',
    method: 'GET',
  });
  if (!response.ok) {
    throw new Error(`Failed to download remote file: ${url}`);
  }
  
  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  const dataArray = new Uint8Array(arrayBuffer);
  
  try {
    if (this.engineInstance) {
      // Save to engine filesystem
      this.engineInstance.FS.writeFile(filePath, dataArray);
    } else {
      // Save directly to IndexedDB for non-engine contexts
      // TODO: Just copying the Godot convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
      await indexedDBUtils.writeToIndexedDB('/userfs', 'FILE_DATA', filePath, dataArray);
    }
    this.logger.debug(`Successfully saved to: ${filePath}`);
  } catch (error) {
    this.logger.error(`Failed to save file: ${error}`);
    throw new Error(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`);
  }
  
  return true;
}

export async function remoteFileExists(this: WavedashSDK, filePath: string): Promise<WavedashResponse<boolean>> {
  const args = { filePath };

  try {
    const url = getRemoteStorageUrl.call(this, args.filePath);
    const response = await fetch(url, { 
      credentials: 'include',
      method: 'HEAD',
    });
    return {
      success: true,
      data: response.ok,
      args: args
    };
  } catch (error) {
    this.logger.error(`Failed to check if remote file exists: ${error}`);
    return {
      success: false,
      data: false,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function uploadRemoteFile(this: WavedashSDK, filePath: string): Promise<WavedashResponse<string>> {
  const args = { filePath };

  try {
    const uploadUrl = await this.convexClient.mutation(
      api.remoteFileStorage.getUploadUrl,
      { path: args.filePath }
    );
    const success = await upload.call(this, uploadUrl, args.filePath);
    return {
      success: success,
      data: filePath,
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

export async function downloadRemoteFile(this: WavedashSDK, filePath: string): Promise<WavedashResponse<string>> {
  const args = { filePath };

  try {
    const url = getRemoteStorageUrl.call(this, args.filePath);
    const success = await download.call(this, url, args.filePath);
    return {
      success: success,
      data: filePath,
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