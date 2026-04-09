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

  async getLeaderboard(name: string): Promise<Leaderboard> {
    const leaderboard = await this.sdk.convexClient.query(
      api.sdk.leaderboards.getLeaderboard,
      { name }
    );
    this.leaderboardCache.set(leaderboard.id, leaderboard);
    return leaderboard;
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<Leaderboard> {
    const leaderboard = await this.sdk.convexClient.mutation(
      api.sdk.leaderboards.getOrCreateLeaderboard,
      { name, sortOrder, displayType }
    );
    this.leaderboardCache.set(leaderboard.id, leaderboard);
    return leaderboard;
  }

  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
  }

  async getMyLeaderboardEntries(
    leaderboardId: Id<"leaderboards">
  ): Promise<LeaderboardEntries> {
    const result = await this.sdk.convexClient.query(
      api.sdk.leaderboards.getMyLeaderboardEntry,
      { leaderboardId }
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
    return entry ? [entry] : [];
  }

  async listLeaderboardEntriesAroundUser(
    leaderboardId: Id<"leaderboards">,
    countAhead: number,
    countBehind: number,
    friendsOnly: boolean = false
  ): Promise<LeaderboardEntries> {
    const result = await this.sdk.convexClient.query(
      api.sdk.leaderboards.listEntriesAroundUser,
      { leaderboardId, countAhead, countBehind, friendsOnly }
    );
    if (result && result.totalEntries) {
      this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
    }
    return result.entries;
  }

  async listLeaderboardEntries(
    leaderboardId: Id<"leaderboards">,
    offset: number,
    limit: number,
    friendsOnly: boolean = false
  ): Promise<LeaderboardEntries> {
    const result = await this.sdk.convexClient.query(
      api.sdk.leaderboards.listEntries,
      { leaderboardId, offset, limit, friendsOnly }
    );
    if (result && result.totalEntries) {
      this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
    }
    return result.entries;
  }

  async uploadLeaderboardScore(
    leaderboardId: Id<"leaderboards">,
    score: number,
    keepBest: boolean,
    ugcId?: Id<"userGeneratedContent">
  ): Promise<UpsertedLeaderboardEntry> {
    const result = await this.sdk.convexClient.mutation(
      api.sdk.leaderboards.upsertLeaderboardEntry,
      { leaderboardId, score, keepBest, ugcId }
    );
    if (result && result.totalEntries) {
      this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
    }
    return {
      ...result.entry,
      userId: this.sdk.wavedashUser.id,
      username: this.sdk.wavedashUser.username
    };
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
