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
  UpsertedLeaderboardEntry,
} from "../types";
import { api } from "../_generated/convex_api";
import type { WavedashSDK } from "../index";

// Once a leaderboard is fetched, we cache it here
// Mainly used to cache the totalEntries value for each leaderboard
// This allows the SDK to return mostly up-to-date totalEntries synchronously without a network call
class LeaderboardCache {
  private cache: Map<Id<"leaderboards">, Leaderboard> = new Map();

  update(leaderboardId: Id<"leaderboards">, totalEntries: number): void {
    const cachedLeaderboard = this.cache.get(leaderboardId);
    if (cachedLeaderboard && typeof totalEntries === "number") {
      this.cache.set(leaderboardId, { ...cachedLeaderboard, totalEntries });
    }
  }

  set(leaderboardId: Id<"leaderboards">, leaderboard: Leaderboard): void {
    this.cache.set(leaderboardId, leaderboard);
  }

  get(leaderboardId: Id<"leaderboards">): Leaderboard | undefined {
    return this.cache.get(leaderboardId);
  }
}

// Assuming we only have one WavedashSDK instance at a time, we can use a global variable to store the leaderboard cache
const leaderboardCache = new LeaderboardCache();

export async function getLeaderboard(
  this: WavedashSDK,
  name: string
): Promise<WavedashResponse<Leaderboard>> {
  const args = { name };

  try {
    const leaderboard = await this.convexClient.query(
      api.leaderboards.getLeaderboard,
      args
    );
    leaderboardCache.set(leaderboard.id, leaderboard);
    return {
      success: true,
      data: leaderboard,
      args: args,
    };
  } catch (error) {
    this.logger.error(`Failed to get leaderboard ${name}`, error);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function getOrCreateLeaderboard(
  this: WavedashSDK,
  name: string,
  sortOrder: LeaderboardSortOrder,
  displayType: LeaderboardDisplayType
): Promise<WavedashResponse<Leaderboard>> {
  const args = { name, sortOrder, displayType };

  try {
    const leaderboard = await this.convexClient.mutation(
      api.leaderboards.getOrCreateLeaderboard,
      args
    );
    leaderboardCache.set(leaderboard.id, leaderboard);
    return {
      success: true,
      data: leaderboard,
      args: args,
    };
  } catch (error) {
    this.logger.error(`Failed to get or create leaderboard ${name}`, error);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getLeaderboardEntryCount(
  this: WavedashSDK,
  leaderboardId: Id<"leaderboards">
): number {
  const cachedLeaderboard = leaderboardCache.get(leaderboardId);
  return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
}

export async function getMyLeaderboardEntries(
  this: WavedashSDK,
  leaderboardId: Id<"leaderboards">
): Promise<WavedashResponse<LeaderboardEntries>> {
  const args = { leaderboardId };

  try {
    const result = await this.convexClient.query(
      api.leaderboards.getMyLeaderboardEntry,
      args
    );
    if (result && result.totalEntries) {
      const totalEntries = result.totalEntries;
      leaderboardCache.update(leaderboardId, totalEntries);
    }
    const entry = result.entry
      ? {
          ...result.entry,
          userId: this.wavedashUser.id,
          username: this.wavedashUser.username,
        }
      : null;

    // TODO: Kind of weird to return a list when it will only ever have 0 or 1 entries
    // But this allows all get entries functions to share the same return type which the game SDK expects
    const entries = entry ? [entry] : [];

    return {
      success: true,
      data: entries,
      args: args,
    };
  } catch (error) {
    this.logger.error(
      `Failed to get my leaderboard entries for leaderboard ${leaderboardId}`,
      error
    );
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listLeaderboardEntriesAroundUser(
  this: WavedashSDK,
  leaderboardId: Id<"leaderboards">,
  countAhead: number,
  countBehind: number
): Promise<WavedashResponse<LeaderboardEntries>> {
  const args = { leaderboardId, countAhead, countBehind };

  try {
    const result = await this.convexClient.query(
      api.leaderboards.listEntriesAroundUser,
      args
    );
    if (result && result.totalEntries) {
      const totalEntries = result.totalEntries;
      leaderboardCache.update(leaderboardId, totalEntries);
    }
    return {
      success: true,
      data: result.entries,
      args: args,
    };
  } catch (error) {
    this.logger.error(
      `Failed to list leaderboard entries around user for leaderboard ${leaderboardId}`,
      error
    );
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function listLeaderboardEntries(
  this: WavedashSDK,
  leaderboardId: Id<"leaderboards">,
  offset: number,
  limit: number
): Promise<WavedashResponse<LeaderboardEntries>> {
  const args = { leaderboardId, offset, limit };

  try {
    const result = await this.convexClient.query(
      api.leaderboards.listEntries,
      args
    );
    if (result && result.totalEntries) {
      const totalEntries = result.totalEntries;
      leaderboardCache.update(leaderboardId, totalEntries);
    }
    return {
      success: true,
      data: result.entries,
      args: args,
    };
  } catch (error) {
    this.logger.error(
      `Failed to list leaderboard entries for leaderboard ${leaderboardId}`,
      error
    );
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function uploadLeaderboardScore(
  this: WavedashSDK,
  leaderboardId: Id<"leaderboards">,
  score: number,
  keepBest: boolean,
  ugcId?: Id<"userGeneratedContent">
): Promise<WavedashResponse<UpsertedLeaderboardEntry>> {
  const args = { leaderboardId, score, keepBest, ugcId };

  try {
    const result = await this.convexClient.mutation(
      api.leaderboards.upsertLeaderboardEntry,
      args
    );
    if (result && result.totalEntries) {
      const totalEntries = result.totalEntries;
      leaderboardCache.update(leaderboardId, totalEntries);
    }
    const entry = {
      ...result.entry,
      userId: this.wavedashUser.id,
      username: this.wavedashUser.username,
    };

    return {
      success: true,
      data: entry,
      args: args,
    };
  } catch (error) {
    this.logger.error(
      `Failed to upload leaderboard score for leaderboard ${leaderboardId}`,
      error
    );
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
