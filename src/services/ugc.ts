/**
 * UGC service
 *
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type { Id, WavedashResponse, UGCType, UGCVisibility } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/types";

export class UGCManager {
  private sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async createUGCItem(
    ugcType: UGCType,
    title?: string,
    description?: string,
    visibility?: UGCVisibility,
    filePath?: string
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    const args = { ugcType, title, description, visibility, filePath };

    try {
      const { ugcId, uploadUrl } = await this.sdk.convexClient.mutation(
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
        const success = await this.sdk.fileSystemManager.upload(
          uploadUrl,
          filePath
        );
        // TODO: This should be handled on the backend using R2 event notifications
        await this.sdk.convexClient.mutation(
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
      this.sdk.logger.error(`Error creating UGC item: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async updateUGCItem(
    ugcId: Id<"userGeneratedContent">,
    title?: string,
    description?: string,
    visibility?: UGCVisibility,
    filePath?: string
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    const args = { ugcId, title, description, visibility, filePath };

    try {
      const { uploadUrl } = await this.sdk.convexClient.mutation(
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
        const success = await this.sdk.fileSystemManager.upload(
          uploadUrl,
          filePath
        );
        // TODO: This should be handled on the backend using R2 event notifications
        await this.sdk.convexClient.mutation(
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
      this.sdk.logger.error(`Error updating UGC item: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async downloadUGCItem(
    ugcId: Id<"userGeneratedContent">,
    filePath: string
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    const args = { ugcId, filePath };

    try {
      const downloadUrl = await this.sdk.convexClient.query(
        api.sdk.userGeneratedContent.getUGCItemDownloadUrl,
        { ugcId: args.ugcId }
      );
      const success = await this.sdk.fileSystemManager.download(
        downloadUrl,
        filePath
      );
      return {
        success: success,
        data: args.ugcId,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error downloading UGC item: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
