/**
 * Friends service
 *
 * Implements friend-related methods for the Wavedash SDK
 */

import type { Friend, WavedashResponse } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/types";

export class FriendsManager {
  private sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async listFriends(): Promise<WavedashResponse<Friend[]>> {
    const args = {};

    try {
      const friends = await this.sdk.convexClient.query(
        api.sdk.friends.listFriends,
        args
      );
      return {
        success: true,
        data: friends,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error("Failed to list friends", error);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}
