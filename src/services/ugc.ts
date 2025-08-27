/**
 * UGC service
 * 
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type {
  Id,
  WavedashResponse,
  UGCType,
  UGCVisibility
} from '../types';
import { api } from '../convex_api';
import * as indexedDBUtils from '../utils/indexedDB';
import type { WavedashSDK } from '../index';

async function uploadFromIndexedDb(this: WavedashSDK, uploadUrl: string, indexedDBKey: string): Promise<boolean> {
  this.logger.debug(`Uploading ${indexedDBKey} to: ${uploadUrl}`);
  try {
    // TODO: Copying Godot's convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
    const record = await indexedDBUtils.getRecordFromIndexedDB('/userfs', 'FILE_DATA', indexedDBKey);
    if (!record) {
      this.logger.error(`File not found in IndexedDB: ${indexedDBKey}`);
      return false;
    }
    const blob = indexedDBUtils.toBlobFromIndexedDBValue(record);
    const response = await fetch(uploadUrl, {
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

async function uploadFromFS(this: WavedashSDK, uploadUrl: string, filePath: string): Promise<boolean> {
  this.logger.debug(`Uploading ${filePath} to: ${uploadUrl}`);
  try {
    if (!this.engineInstance?.FS) {
      throw new Error('Engine instance is missing the Emscripten FS API');
    }
    const exists = this.engineInstance.FS.analyzePath(filePath).exists;
    if (!exists) {
      throw new Error(`File not found in FS: ${filePath}`);
    }
    const blob = this.engineInstance.FS.readFile(filePath) as Uint8Array;
    const response = await fetch(uploadUrl, {
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

export async function createUGCItem(this: WavedashSDK, ugcType: UGCType, title?: string, description?: string, visibility?: UGCVisibility, filePath?: string): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcType, title, description, visibility, filePath }

  try {
    if (filePath && this.engineInstance && !this.engineInstance.FS) {
      throw new Error('Engine instance is missing the Emscripten FS API');
    }
    const { ugcId, uploadUrl } = await this.convexClient.mutation(
      api.userGeneratedContent.createUGCItem,
      { ugcType, title, description, visibility, createPresignedUploadUrl: !!filePath }
    );
    if (filePath && !uploadUrl) {
      throw new Error(`Failed to create a presigned upload URL for UGC item: ${filePath}`);
    }
    else if (filePath && uploadUrl) {
      let success = false;
      if (this.engineInstance?.FS) {
        success = await uploadFromFS.call(this, uploadUrl, filePath);
      }
      else {
        success = await uploadFromIndexedDb.call(this, uploadUrl, filePath);
      }
      // TODO: This should be handled on the backend using R2 event notifications
      await this.convexClient.mutation(
        api.userGeneratedContent.finishUGCUpload,
        { success: success, ugcId: ugcId }
      );
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return {
      success: true,
      data: ugcId as Id<"userGeneratedContent">,
      args: args
    };
  }
  catch (error) {
    this.logger.error(`Error creating UGC item: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function updateUGCItem(this: WavedashSDK, ugcId: Id<"userGeneratedContent">, title?: string, description?: string, visibility?: UGCVisibility, filePath?: string): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcId, title, description, visibility, filePath }

  try {
    if (filePath && this.engineInstance && !this.engineInstance.FS) {
      throw new Error('Engine instance is missing the Emscripten FS API');
    }
    const { uploadUrl } = await this.convexClient.mutation(
      api.userGeneratedContent.updateUGCItem,
      { ugcId, title, description, visibility, createPresignedUploadUrl: !!filePath }
    );
    if (filePath && !uploadUrl) {
      throw new Error(`Failed to create a presigned upload URL for UGC item: ${filePath}`);
    }
    else if (filePath && uploadUrl) {
      let success = false;
      if (this.engineInstance?.FS) {
        success = await uploadFromFS.call(this, uploadUrl, filePath);
      }
      else {
        success = await uploadFromIndexedDb.call(this, uploadUrl, filePath);
      }
      // TODO: This should be handled on the backend using R2 event notifications
      await this.convexClient.mutation(
        api.userGeneratedContent.finishUGCUpload,
        { success: success, ugcId: ugcId }
      );
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return {
      success: true,
      data: ugcId,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error updating UGC item: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function downloadUGCItem(this: WavedashSDK, ugcId: Id<"userGeneratedContent">, filePath: string): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcId, filePath }

  try {
    if (this.engineInstance && !this.engineInstance.FS) {
      throw new Error('Engine instance is missing the Emscripten FS API');
    }
    const downloadUrl = await this.convexClient.query(
      api.userGeneratedContent.getUGCItemDownloadUrl,
      { ugcId: args.ugcId }
    );
    const response = await fetch(downloadUrl, { credentials: 'include' });
    if (!response.ok) {
      throw new Error(`Failed to download UGC item: ${downloadUrl}`);
    }
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const dataArray = new Uint8Array(arrayBuffer);

    this.logger.debug(`Writing UGC item to filesystem: ${args.filePath}`);

    try {
      if (this.engineInstance?.FS) {
        // Save to engine filesystem
        this.engineInstance.FS.writeFile(args.filePath, dataArray);
      } else {
        // Save directly to IndexedDB for non-engine contexts
        // TODO: Just copying the Godot convention for IndexedDB file structure for now, we may want our own for JS games, but it's arbitrary
        await indexedDBUtils.writeToIndexedDB('/userfs', 'FILE_DATA', args.filePath, dataArray);
      }
      this.logger.debug(`Successfully saved to: ${args.filePath}`);
    } catch (error) {
      this.logger.error(`Failed to save file: ${error}`);
      throw new Error(`Failed to save file: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      success: true,
      data: args.ugcId,
      args: args
    };
  }
  catch (error) {
    this.logger.error(`Error downloading UGC item: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}