import { api } from "@wvdsh/types";
import type { WavedashSDK } from "..";
import debounce from "lodash.debounce";

type StatEntry = { identifier: string; value: number };

const STORE_STATS_DEBOUNCE_MS = 1000;

export class StatsManager {
  private sdk: WavedashSDK;
  private stats: Map<string, number> = new Map();
  private achievementIdentifiers: Set<string> = new Set();

  private updatedStatIdentifiers: Set<string> = new Set();
  private updatedAchievementIdentifiers: Set<string> = new Set();

  private unsubscribeAchievements?: () => void;
  private hasLoadedStats: boolean = false;
  private hasLoadedAchievements: boolean = false;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
    this.subscribeAchievements();
    this.requestStats().catch((error) => {
      this.sdk.logger.error("Initial stats fetch failed:", error);
    });
  }

  destroy(): void {
    if (this.unsubscribeAchievements) {
      this.unsubscribeAchievements();
      this.unsubscribeAchievements = undefined;
    }
  }

  private isReady(): boolean {
    return this.hasLoadedStats && this.hasLoadedAchievements;
  }

  private subscribeAchievements(): void {
    this.unsubscribeAchievements = this.sdk.convexClient.onUpdate(
      api.sdk.gameAchievements.getMyAchievementsForGame,
      {},
      (achievements) => {
        this.hasLoadedAchievements = true;
        for (const { achievement } of achievements) {
          this.achievementIdentifiers.add(achievement.identifier);
        }
      },
      (error) => {
        this.sdk.logger.error("Achievement subscription error:", error);
      }
    );
  }

  async requestStats(): Promise<boolean> {
    const newStats: StatEntry[] = await this.sdk.convexClient.query(
      api.sdk.gameAchievements.getMyStatsForGame,
      {}
    );
    this.hasLoadedStats = true;
    for (const stat of newStats) {
      if (!this.stats.has(stat.identifier)) {
        this.stats.set(stat.identifier, stat.value);
      }
    }
    return true;
  }

  private debouncedStoreStats = debounce(
    this.storeStatsInternal.bind(this),
    STORE_STATS_DEBOUNCE_MS,
    { leading: true, trailing: true }
  );

  // TODO: This is annoying, storeStats should return a Promise and actually fire off the request if there are any new stats to store
  // Breaking change so saving for another PR
  storeStats(): boolean {
    if (!this.isReady()) return false;
    this.debouncedStoreStats();
    return true;
  }

  private async storeStatsInternal(): Promise<boolean> {
    try {
      if (!this.isReady()) return false;

      // Atomically capture and clear identifiers to avoid race conditions
      const statIdentifiersToStore = new Set(this.updatedStatIdentifiers);
      const achievementIdentifiersToStore = new Set(
        this.updatedAchievementIdentifiers
      );

      this.updatedStatIdentifiers.clear();
      this.updatedAchievementIdentifiers.clear();

      const updatedStats: StatEntry[] = [];
      for (const id of statIdentifiersToStore) {
        const value = this.stats.get(id);
        if (value !== undefined) {
          updatedStats.push({ identifier: id, value });
        }
      }

      const updatedAchievements = Array.from(
        this.achievementIdentifiers
      ).filter((achievement) => achievementIdentifiersToStore.has(achievement));

      await Promise.all([
        updatedStats.length > 0
          ? this.sdk.convexClient.mutation(
              api.sdk.gameAchievements.setUserGameStats,
              { stats: updatedStats }
            )
          : Promise.resolve(),
        updatedAchievements.length > 0
          ? this.sdk.convexClient.mutation(
              api.sdk.gameAchievements.setUserGameAchievements,
              { achievements: updatedAchievements }
            )
          : Promise.resolve()
      ]);
      return true;
    } catch (error) {
      this.sdk.logger.error(`Error storing stats: ${error}`);
      return false;
    }
  }

  setAchievement(identifier: string): boolean {
    if (!this.isReady()) return false;
    if (!this.achievementIdentifiers.has(identifier)) {
      this.achievementIdentifiers.add(identifier);
      this.updatedAchievementIdentifiers.add(identifier);
      this.storeStats();
    }
    return true;
  }

  getAchievement(identifier: string): boolean {
    if (!this.isReady()) return false;
    return this.achievementIdentifiers.has(identifier);
  }

  setStat(identifier: string, value: number, storeNow: boolean = false): boolean {
    if (!this.isReady()) return false;
    const current = this.stats.get(identifier);
    if (current !== value) {
      this.stats.set(identifier, value);
      this.updatedStatIdentifiers.add(identifier);
    }
    if (storeNow) {
      this.storeStats();
    }
    return true;
  }

  getStat(identifier: string): number {
    if (!this.isReady()) return 0;
    return this.stats.get(identifier) ?? 0;
  }

  getPendingData(): { stats: StatEntry[]; achievements: string[] } | null {
    const pendingStats: StatEntry[] = [];
    for (const id of this.updatedStatIdentifiers) {
      const value = this.stats.get(id);
      if (value !== undefined) {
        pendingStats.push({ identifier: id, value });
      }
    }
    const pendingAchievements = Array.from(this.achievementIdentifiers).filter(
      (id) => this.updatedAchievementIdentifiers.has(id)
    );

    if (pendingStats.length === 0 && pendingAchievements.length === 0) {
      return null;
    }

    return { stats: pendingStats, achievements: pendingAchievements };
  }
}
