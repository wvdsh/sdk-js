/**
 * UGC service
 *
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type { Id, UGCType, UGCVisibility } from "../types";
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
  ): Promise<Id<"userGeneratedContent">> {
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
        { success, ugcId }
      );
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return ugcId;
  }

  async updateUGCItem(
    ugcId: Id<"userGeneratedContent">,
    title?: string,
    description?: string,
    visibility?: UGCVisibility,
    filePath?: string
  ): Promise<Id<"userGeneratedContent">> {
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
        { success, ugcId }
      );
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return ugcId;
  }

  async downloadUGCItem(
    ugcId: Id<"userGeneratedContent">,
    filePath: string
  ): Promise<Id<"userGeneratedContent">> {
    const downloadUrl = await this.sdk.convexClient.query(
      api.sdk.userGeneratedContent.getUGCItemDownloadUrl,
      { ugcId }
    );
    const success = await this.sdk.fileSystemManager.download(
      downloadUrl,
      filePath
    );
    if (!success) {
      throw new Error(`Failed to download UGC item: ${ugcId}`);
    }
    return ugcId;
  }
}
