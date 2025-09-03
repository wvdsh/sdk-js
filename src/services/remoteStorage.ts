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

export async function fileExists(this: WavedashSDK, filePath: string): Promise<WavedashResponse<boolean>> {
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
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}