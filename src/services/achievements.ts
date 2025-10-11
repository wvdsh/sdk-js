import { WavedashResponse, WavedashSDK } from "..";
import { api } from "../_generated/convex_api";

export class AchievementsManager {
  private sdk: WavedashSDK;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async setAchievement(identifier: string): Promise<WavedashResponse<void>> {
    const args = { identifier };
    try {
      await this.sdk.convexClient.mutation(
        api.gameAchievements.setAchievement,
        args
      );
      return {
        success: true,
        data: undefined,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error setting achievement: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
      };
    }
  }

  async getAchievement(identifier: string): Promise<WavedashResponse<boolean>> {
    const args = { identifier };

    try {
      const response = await this.sdk.convexClient.query(
        api.gameAchievements.getAchievement,
        args
      );
      return {
        success: true,
        data: response,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error getting achievement: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
      };
    }
  }

  async setStat(
    identifier: string,
    value: number
  ): Promise<WavedashResponse<void>> {
    const args = { identifier, value };

    try {
      await this.sdk.convexClient.mutation(api.gameAchievements.setStat, args);
      return {
        success: true,
        data: undefined,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error setting stat: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
      };
    }
  }

  async getStat(identifier: string): Promise<WavedashResponse<number>> {
    const args = { identifier };

    try {
      const response = await this.sdk.convexClient.query(
        api.gameAchievements.getStat,
        args
      );
      return {
        success: true,
        data: response,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error getting stat: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
      };
    }
  }
}
