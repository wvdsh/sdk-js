/**
 * Leaderboard service
 *
 * Implements each of the leaderboard methods of the Wavedash SDK
 */

import type {
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  Leaderboard,
  LeaderboardEntries,
  LeaderboardEntryMetadata,
  UpsertedLeaderboardEntry,
  LeaderboardId,
  UGCId
} from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/api";
import { getAvatarUrl } from "../utils/cdn";
import { PromiseCache } from "../utils/promiseCache";
import { WavedashManager } from "./manager";

type CreatedLeaderboard = Leaderboard & { created: boolean };

export class LeaderboardManager extends WavedashManager {
  // How long entry reads are reused. Uploads invalidate them immediately.
  private static readonly ENTRIES_CACHE_TTL_MS = 2_000;

  // Cache leaderboards to return totalEntries synchronously without a network call
  private leaderboardCache: Map<LeaderboardId, Leaderboard> = new Map();
  // A leaderboard's id never changes, so each name is looked up once per session
  private leaderboardIdsByName: Map<string, LeaderboardId> = new Map();
  // In-flight dedupe only (TTL 0); resolved handles live in the maps above
  private pendingGetLeaderboard = new PromiseCache<string, Leaderboard>(0);
  private pendingGetOrCreateLeaderboard = new PromiseCache<
    string,
    CreatedLeaderboard
  >(0);
  // Short-lived entry reads, one cache per leaderboard so an upload can drop them all
  private entryReadCaches: Map<LeaderboardId, PromiseCache<string, unknown>> =
    new Map();

  constructor(sdk: WavedashSDK) {
    super(sdk);
  }

  async getLeaderboard(name: string): Promise<Leaderboard> {
    const cached = this.getCachedLeaderboardByName(name);
    if (cached) return cached;
    const leaderboard = await this.pendingGetLeaderboard.get(name, async () => {
      const leaderboard = await this.sdk.convexClient.query(
        api.sdk.leaderboards.getLeaderboard,
        { name }
      );
      this.cacheLeaderboard(name, leaderboard);
      return leaderboard;
    });
    return { ...leaderboard };
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<Leaderboard> {
    const cached = this.getCachedLeaderboardByName(name);
    if (cached) {
      // Already known to exist, so this call didn't create it
      const leaderboard: CreatedLeaderboard = { ...cached, created: false };
      return leaderboard;
    }
    let isFirstCaller = false;
    const leaderboard = await this.pendingGetOrCreateLeaderboard.get(
      name,
      async () => {
        isFirstCaller = true;
        const leaderboard = await this.sdk.convexClient.mutation(
          api.sdk.leaderboards.getOrCreateLeaderboard,
          { name, sortOrder, displayType }
        );
        this.cacheLeaderboard(name, leaderboard);
        return leaderboard;
      }
    );
    // Callers that joined another caller's in-flight request didn't create it
    const result: CreatedLeaderboard = {
      ...leaderboard,
      created: isFirstCaller && leaderboard.created
    };
    return result;
  }

  getLeaderboardEntryCount(leaderboardId: LeaderboardId): number {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
  }

  async getMyLeaderboardEntries(
    leaderboardId: LeaderboardId
  ): Promise<LeaderboardEntries> {
    const result = await this.readEntries(
      leaderboardId,
      ["getMyLeaderboardEntry"],
      () =>
        this.sdk.convexClient.query(
          api.sdk.leaderboards.getMyLeaderboardEntry,
          { leaderboardId }
        )
    );
    const entry = result.entry
      ? {
          ...result.entry,
          userId: this.sdk.wavedashUser.id,
          username: this.sdk.wavedashUser.username,
          userAvatarUrl: getAvatarUrl(this.sdk.wavedashUser.avatarUrl, this.sdk)
        }
      : null;

    // TODO: Kind of weird to return a list when it will only ever have 0 or 1 entries
    // But this allows all get entries functions to share the same return type which the game SDK expects
    return entry ? [entry] : [];
  }

  async listLeaderboardEntriesAroundUser(
    leaderboardId: LeaderboardId,
    countAhead: number,
    countBehind: number,
    friendsOnly: boolean = false
  ): Promise<LeaderboardEntries> {
    const result = await this.readEntries(
      leaderboardId,
      ["listEntriesAroundUser", countAhead, countBehind, friendsOnly],
      () =>
        this.sdk.convexClient.query(
          api.sdk.leaderboards.listEntriesAroundUser,
          { leaderboardId, countAhead, countBehind, friendsOnly }
        )
    );
    // Cache raw keys before URL-ifying so getUserAvatarUrl() can still size them.
    this.sdk.friendsManager.cacheLeaderboardPage(result.entries);
    return result.entries.map((entry) => ({
      ...entry,
      userAvatarUrl: getAvatarUrl(entry.userAvatarUrl, this.sdk)
    }));
  }

  async listLeaderboardEntries(
    leaderboardId: LeaderboardId,
    offset: number,
    limit: number,
    friendsOnly: boolean = false
  ): Promise<LeaderboardEntries> {
    const result = await this.readEntries(
      leaderboardId,
      ["listEntries", offset, limit, friendsOnly],
      () =>
        this.sdk.convexClient.query(api.sdk.leaderboards.listEntries, {
          leaderboardId,
          offset,
          limit,
          friendsOnly
        })
    );
    // Cache raw keys before URL-ifying so getUserAvatarUrl() can still size them.
    this.sdk.friendsManager.cacheLeaderboardPage(result.entries);
    return result.entries.map((entry) => ({
      ...entry,
      userAvatarUrl: getAvatarUrl(entry.userAvatarUrl, this.sdk)
    }));
  }

  async uploadLeaderboardScore(
    leaderboardId: LeaderboardId,
    score: number,
    keepBest: boolean,
    ugcId?: UGCId,
    metadata?: LeaderboardEntryMetadata
  ): Promise<UpsertedLeaderboardEntry> {
    const result = await this.sdk.convexClient.mutation(
      api.sdk.leaderboards.upsertLeaderboardEntry,
      { leaderboardId, score, keepBest, ugcId, metadata }
    );
    // Drop cached reads so the game's next read sees its own write
    this.entryReadCaches.delete(leaderboardId);
    if (result && result.totalEntries) {
      this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
    }
    return {
      // Where your current leaderboard standing ranks
      ...result.entry,
      // Where the submission itself ranks
      submittedScore: result.submission.score,
      submittedRank: result.submission.globalRank,
      // User info
      userId: this.sdk.wavedashUser.id,
      username: this.sdk.wavedashUser.username,
      userAvatarUrl: getAvatarUrl(this.sdk.wavedashUser.avatarUrl, this.sdk)
    };
  }

  // ================
  // Private Methods
  // ================

  private cacheLeaderboard(name: string, leaderboard: Leaderboard): void {
    const { id, totalEntries } = leaderboard;
    // Store only the Leaderboard fields, getOrCreate's `created` is per call
    this.leaderboardCache.set(id, { id, name: leaderboard.name, totalEntries });
    this.leaderboardIdsByName.set(name, id);
  }

  /** A copy of the cached leaderboard for a name, with the latest totalEntries */
  private getCachedLeaderboardByName(name: string): Leaderboard | null {
    const id = this.leaderboardIdsByName.get(name);
    const leaderboard = id && this.leaderboardCache.get(id);
    return leaderboard ? { ...leaderboard } : null;
  }

  /**
   * Run an entries query through its leaderboard's short-lived read cache,
   * keyed by the full args. totalEntries is recorded once per network fetch,
   * and skipped if an upload invalidated the cache while the fetch was in
   * flight (the upload's own count is newer).
   */
  private readEntries<T extends { totalEntries: number }>(
    leaderboardId: LeaderboardId,
    args: unknown[],
    query: () => Promise<T>
  ): Promise<T> {
    const cache =
      this.entryReadCaches.get(leaderboardId) ??
      new PromiseCache<string, unknown>(
        LeaderboardManager.ENTRIES_CACHE_TTL_MS
      );
    this.entryReadCaches.set(leaderboardId, cache);
    return cache.get(JSON.stringify(args), async () => {
      const result = await query();
      if (
        result &&
        result.totalEntries &&
        this.entryReadCaches.get(leaderboardId) === cache
      ) {
        this.updateCachedTotalEntries(leaderboardId, result.totalEntries);
      }
      return result;
    }) as Promise<T>;
  }

  private updateCachedTotalEntries(
    leaderboardId: LeaderboardId,
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
