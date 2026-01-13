/**
 * UGC service
 *
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type { Id, WavedashResponse, UGCType, UGCVisibility } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/types";

export async function createUGCItem(
  this: WavedashSDK,
  ugcType: UGCType,
  title?: string,
  description?: string,
  visibility?: UGCVisibility,
  filePath?: string
): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcType, title, description, visibility, filePath };

  try {
    const { ugcId, uploadUrl } = await this.convexClient.mutation(
      api.sdk.userGeneratedContent.createUGCItem,
      {
        ugcType,
        title,
        description,
        visibility,
        createPresignedUploadUrl: !!filePath
      }
    );
    if (filePath && !uploadUrl) {
      throw new Error(
        `Failed to create a presigned upload URL for UGC item: ${filePath}`
      );
    } else if (filePath && uploadUrl) {
      const success = await this.fileSystemManager.upload(
        uploadUrl,
        filePath
      );
      // TODO: This should be handled on the backend using R2 event notifications
      await this.convexClient.mutation(
        api.sdk.userGeneratedContent.finishUGCUpload,
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
    this.logger.error(`Error creating UGC item: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function updateUGCItem(
  this: WavedashSDK,
  ugcId: Id<"userGeneratedContent">,
  title?: string,
  description?: string,
  visibility?: UGCVisibility,
  filePath?: string
): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcId, title, description, visibility, filePath };

  try {
    const { uploadUrl } = await this.convexClient.mutation(
      api.sdk.userGeneratedContent.updateUGCItem,
      {
        ugcId,
        title,
        description,
        visibility,
        createPresignedUploadUrl: !!filePath
      }
    );
    if (filePath && !uploadUrl) {
      throw new Error(
        `Failed to create a presigned upload URL for UGC item: ${filePath}`
      );
    } else if (filePath && uploadUrl) {
      const success = await this.fileSystemManager.upload(
        uploadUrl,
        filePath
      );
      // TODO: This should be handled on the backend using R2 event notifications
      await this.convexClient.mutation(
        api.sdk.userGeneratedContent.finishUGCUpload,
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

export async function downloadUGCItem(
  this: WavedashSDK,
  ugcId: Id<"userGeneratedContent">,
  filePath: string
): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
  const args = { ugcId, filePath };

  try {
    const downloadUrl = await this.convexClient.query(
      api.sdk.userGeneratedContent.getUGCItemDownloadUrl,
      { ugcId: args.ugcId }
    );
    const success = await this.fileSystemManager.download(
      downloadUrl,
      filePath
    );
    return {
      success: success,
      data: args.ugcId,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error downloading UGC item: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
