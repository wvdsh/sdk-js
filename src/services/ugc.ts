/**
 * UGC service
 *
 * Implements each of the user generated content methods of the Wavedash SDK
 */

import type {
  UGCType,
  UGCVisibility,
  UpdateUGCItemArgs,
  PaginatedUGCItems,
  ListUGCItemsArgs,
  UGCId
} from "../types";
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
  ): Promise<UGCId> {
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
      if (!success) {
        throw new Error(`Failed to upload UGC item: ${filePath}`);
      }
    }
    return ugcId;
  }

  async updateUGCItem(
    ugcId: UGCId,
    updates: UpdateUGCItemArgs = {}
  ): Promise<UGCId> {
    const { title, description, visibility, filePath } = updates;
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

  async deleteUGCItem(ugcId: UGCId): Promise<UGCId> {
    await this.sdk.convexClient.mutation(
      api.sdk.userGeneratedContent.deleteUGCItem,
      { ugcId }
    );
    return ugcId;
  }

  async downloadUGCItem(ugcId: UGCId, filePath: string): Promise<UGCId> {
    const downloadUrl = await this.sdk.convexClient.query(
      api.sdk.userGeneratedContent.getUGCItemDownloadUrl,
      { ugcId }
    );
    try {
      await this.sdk.fileSystemManager.download(downloadUrl, filePath);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to download UGC item ${ugcId}: ${msg}`);
    }
    return ugcId;
  }

  async listUGCItems(args: ListUGCItemsArgs = {}): Promise<PaginatedUGCItems> {
    const { createdBy, ugcType, titleSearch, numItems, continueCursor } = args;
    const filters =
      createdBy !== undefined ||
      ugcType !== undefined ||
      titleSearch !== undefined
        ? { createdBy, ugcType, titleSearch }
        : undefined;
    return await this.sdk.convexClient.query(
      api.sdk.userGeneratedContent.listUGCItems,
      {
        filters,
        numItems,
        continueCursor
      }
    );
  }
}
