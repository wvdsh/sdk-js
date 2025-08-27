import type {
  Id,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry,
  WavedashUser
} from '../types';
import { api } from '../convex_api';
import type { ConvexClient } from 'convex/browser';
import { WavedashLogger } from '../utils/logger';

export class LeaderboardService {
  private cache: Map<Id<"leaderboards">, Leaderboard> = new Map();

  constructor(
    private convexClient: ConvexClient,
    private wavedashUser: WavedashUser,
    private logger: WavedashLogger
  ) { }

  // Helper to update the leaderboard cache with the latest totalEntries value
  private updateCache(leaderboardId: Id<"leaderboards">, totalEntries: number): void {
    const cachedLeaderboard = this.cache.get(leaderboardId);
    if (cachedLeaderboard && typeof totalEntries === "number") {
      this.cache.set(leaderboardId, { ...cachedLeaderboard, totalEntries });
    }
  }

  async getLeaderboard(name: string): Promise<WavedashResponse<Leaderboard>> {
    const args = { name };

    try {
      const leaderboard = await this.convexClient.query(
        api.leaderboards.getLeaderboard,
        args
      );
      this.cache.set(leaderboard.id, leaderboard);
      return {
        success: true,
        data: leaderboard,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getOrCreateLeaderboard(name: string, sortOrder: LeaderboardSortOrder, displayType: LeaderboardDisplayType): Promise<WavedashResponse<Leaderboard>> {
    const args = { name, sortOrder, displayType };

    try {
      const leaderboard = await this.convexClient.mutation(
        api.leaderboards.getOrCreateLeaderboard,
        args
      );
      this.cache.set(leaderboard.id, leaderboard);
      return {
        success: true,
        data: leaderboard,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async getMyLeaderboardEntries(leaderboardId: Id<"leaderboards">): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId };

    try {
      const result = await this.convexClient.query(
        api.leaderboards.getMyLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateCache(leaderboardId, totalEntries);
      }
      const entry = result.entry ? {
        ...result.entry,
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username
      } : null;

      // TODO: Kind of weird to return a list when it will only ever have 0 or 1 entries
      // But this allows all get entries functions to share the same return type which the game SDK expects
      const entries = entry ? [entry] : [];

      return {
        success: true,
        data: entries,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    const cachedLeaderboard = this.cache.get(leaderboardId);
    return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
  }

  async listLeaderboardEntriesAroundUser(leaderboardId: Id<"leaderboards">, countAhead: number, countBehind: number): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId, countAhead, countBehind };

    try {
      const result = await this.convexClient.query(
        api.leaderboards.listEntriesAroundUser,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateCache(leaderboardId, totalEntries);
      }
      return {
        success: true,
        data: result.entries,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listLeaderboardEntries(leaderboardId: Id<"leaderboards">, offset: number, limit: number): Promise<WavedashResponse<LeaderboardEntries>> {
    const args = { leaderboardId, offset, limit };

    try {
      const result = await this.convexClient.query(
        api.leaderboards.listEntries,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateCache(leaderboardId, totalEntries);
      }
      return {
        success: true,
        data: result.entries,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async uploadLeaderboardScore(leaderboardId: Id<"leaderboards">, score: number, keepBest: boolean, ugcId?: Id<"userGeneratedContent">): Promise<WavedashResponse<UpsertedLeaderboardEntry>> {
    const args = { leaderboardId, score, keepBest, ugcId };

    try {
      const result = await this.convexClient.mutation(
        api.leaderboards.upsertLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateCache(leaderboardId, totalEntries);
      }
      const entry = {
        ...result.entry,
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username
      };

      return {
        success: true,
        data: entry,
        args: args
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

