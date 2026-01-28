/**
 * Leaderboard service
 *
 * Implements each of the leaderboard methods of the Wavedash SDK
 */

import type {
  Id,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry
} from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/types";

export class LeaderboardManager {
  private sdk: WavedashSDK;

  // Cache leaderboards to return totalEntries synchronously without a network call
  private leaderboardCache: Map<Id<"leaderboards">, Leaderboard> = new Map();

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async getLeaderboard(name: string): Promise<WavedashResponse<Leaderboard>> {
    const args = { name };

    try {
      const leaderboard = await this.sdk.convexClient.query(
        api.sdk.leaderboards.getLeaderboard,
        args
      );
      this.leaderboardCache.set(leaderboard.id, leaderboard);
      return {
        success: true,
        data: leaderboard,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Failed to get leaderboard ${name}`, error);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<WavedashResponse<Leaderboard>> {
    const args = { name, sortOrder, displayType };

    try {
      const leaderboard = await this.sdk.convexClient.mutation(
        api.sdk.leaderboards.getOrCreateLeaderboard,
        args
      );
      this.leaderboardCache.set(leaderboard.id, leaderboard);
      return {
        success: true,
        data: leaderboard,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(
        `Failed to get or create leaderboard ${name}`,
        error
      );
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
  }

  async getMyLeaderboardEntries(
    leaderboardId: Id<"leaderboards">
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId };

    try {
      const result = await this.sdk.convexClient.query(
        api.sdk.leaderboards.getMyLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
      }
      const entry = result.entry
        ? {
            ...result.entry,
            userId: this.sdk.wavedashUser.id,
            username: this.sdk.wavedashUser.username
          }
        : null;

      // TODO: Kind of weird to return a list when it will only ever have 0 or 1 entries
      // But this allows all get entries functions to share the same return type which the game SDK expects
      const entries = entry ? [entry] : [];

      return {
        success: true,
        data: entries,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(
        `Failed to get my leaderboard entries for leaderboard ${leaderboardId}`,
        error
      );
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listLeaderboardEntriesAroundUser(
    leaderboardId: Id<"leaderboards">,
    countAhead: number,
    countBehind: number,
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId, countAhead, countBehind, friendsOnly };

    try {
      const result = await this.sdk.convexClient.query(
        api.sdk.leaderboards.listEntriesAroundUser,
        args
      );
      if (result && result.totalEntries) {
        this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
      }
      return {
        success: true,
        data: result.entries,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(
        `Failed to list leaderboard entries around user for leaderboard ${leaderboardId}`,
        error
      );
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listLeaderboardEntries(
    leaderboardId: Id<"leaderboards">,
    offset: number,
    limit: number,
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId, offset, limit, friendsOnly };

    try {
      const result = await this.sdk.convexClient.query(
        api.sdk.leaderboards.listEntries,
        args
      );
      if (result && result.totalEntries) {
        this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
      }
      return {
        success: true,
        data: result.entries,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(
        `Failed to list leaderboard entries for leaderboard ${leaderboardId}`,
        error
      );
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async uploadLeaderboardScore(
    leaderboardId: Id<"leaderboards">,
    score: number,
    keepBest: boolean,
    ugcId?: Id<"userGeneratedContent">
  ): Promise<WavedashResponse<UpsertedLeaderboardEntry>> {
    const args = { leaderboardId, score, keepBest, ugcId };

    try {
      const result = await this.sdk.convexClient.mutation(
        api.sdk.leaderboards.upsertLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
      }
      const entry = {
        ...result.entry,
        userId: this.sdk.wavedashUser.id,
        username: this.sdk.wavedashUser.username
      };

      return {
        success: true,
        data: entry,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(
        `Failed to upload leaderboard score for leaderboard ${leaderboardId}`,
        error
      );
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // ================
  // Private Methods
  // ================

  private updateCachedTotalEntries(
    leaderboardId: Id<"leaderboards">,
    totalEntries: number
  ): void {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    if (cachedLeaderboard && typeof totalEntries === "number") {
      this.leaderboardCache.set(leaderboardId, {
        ...cachedLeaderboard,
        totalEntries
      });
    }
  }
}
