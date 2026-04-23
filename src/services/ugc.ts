/**
 * UGC service
 *
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type { Id, UGCType, UGCVisibility } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/api";
import { WavedashManager } from "./manager";

export class UGCManager extends WavedashManager {
  constructor(sdk: WavedashSDK) {
    super(sdk);
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
      // Status flips to COMPLETED via the R2 event-notification webhook on the
      // server. If the PUT failed, we throw here and a server-side reaper flips
      // the row UPLOADING → FAILED after a timeout.
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
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return ugcId;
  }

  async deleteUGCItem(
    ugcId: Id<"userGeneratedContent">
  ): Promise<Id<"userGeneratedContent">> {
    await this.sdk.convexClient.mutation(
      api.sdk.userGeneratedContent.deleteUGCItem,
      { ugcId }
    );
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
