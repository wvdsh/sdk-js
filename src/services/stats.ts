import { api } from "@wvdsh/api";
import type { WavedashSDK } from "..";
import type { StatsStoredPayload } from "../types";
import { WavedashEvents } from "../events";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { createThrottledSender } from "../utils/throttledSender";

type StatEntry = { identifier: string; value: number };

const STORE_THROTTLE_MS = 1000;

export class StatsManager extends WavedashManager {
  // Current user values
  private stats: Map<string, number> = new Map();
  private unlockedAchievements: Set<string> = new Set();

  // Dirty tracking — identifiers modified since last persist
  private dirtyStats: Set<string> = new Set();
  private dirtyAchievements: Set<string> = new Set();

  // Valid identifiers from game definitions — empty until subscription fires,
  // which naturally gates set/get calls (has() returns false on empty set)
  private knownStatIds: Set<string> = new Set();
  private knownAchievementIds: Set<string> = new Set();

  // Must load user values before allowing set/get to prevent overwriting server state
  private loaded = { stats: false, achievements: false };

  // Subscription cleanup
  private subscriptions: (() => void)[] = [];

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.subscribe();
    this.requestStats().catch((error) => {
      logger.error("Initial stats fetch failed:", error);
    });
  }

  destroy(): void {
    this.persistSender.cancel();
    for (const unsub of this.subscriptions) unsub();
    this.subscriptions = [];
  }

  private isReady(): boolean {
    return this.loaded.stats && this.loaded.achievements;
  }

  // ================
  // Subscriptions
  // ================

  private subscribe(): void {
    this.subscriptions.push(
      this.sdk.convexClient.onUpdate(
        api.sdk.gameAchievements.listGameStatIdentifiers,
        { gameCloudId: this.sdk.gameCloudId },
        (ids) => {
          this.knownStatIds = new Set(ids);
        },
        (error) => {
          logger.error("Stat identifiers subscription error:", error);
        }
      ),
      this.sdk.convexClient.onUpdate(
        api.sdk.gameAchievements.listGameAchievementIdentifiers,
        { gameCloudId: this.sdk.gameCloudId },
        (ids) => {
          this.knownAchievementIds = new Set(ids);
        },
        (error) => {
          logger.error("Achievement identifiers subscription error:", error);
        }
      ),
      this.sdk.convexClient.onUpdate(
        api.sdk.gameAchievements.getMyAchievementsForGame,
        {},
        (achievements) => {
          this.loaded.achievements = true;
          for (const { achievement } of achievements) {
            this.unlockedAchievements.add(achievement.identifier);
          }
        },
        (error) => {
          logger.error("Achievement subscription error:", error);
        }
      )
    );
  }

  async requestStats(): Promise<boolean> {
    const newStats: StatEntry[] = await this.sdk.convexClient.query(
      api.sdk.gameAchievements.getMyStatsForGame,
      {}
    );
    this.loaded.stats = true;
    for (const stat of newStats) {
      if (!this.stats.has(stat.identifier)) {
        this.stats.set(stat.identifier, stat.value);
      }
    }
    return true;
  }

  // ================
  // Store / Persist
  // ================

  // leading: false so a single setStat doesn't fire synchronously inside the
  // setter. storeNow=true (and storeStats()) flush to fire the pending
  // invocation immediately.
  private persistSender = createThrottledSender({
    waitMs: STORE_THROTTLE_MS,
    leading: false,
    hasPending: () =>
      this.dirtyStats.size > 0 || this.dirtyAchievements.size > 0,
    send: () => this.persist()
  });

  storeStats(): boolean {
    if (!this.isReady()) return false;
    this.persistSender.schedule();
    this.persistSender.flush();
    return true;
  }

  private async persist(): Promise<void> {
    const pending = this.getPendingData()!;
    await Promise.all([
      pending.stats.length > 0
        ? this.sdk.convexClient.mutation(
            api.sdk.gameAchievements.setUserGameStats,
            { stats: pending.stats }
          )
        : Promise.resolve(),
      pending.achievements.length > 0
        ? this.sdk.convexClient.mutation(
            api.sdk.gameAchievements.setUserGameAchievements,
            { achievements: pending.achievements }
          )
        : Promise.resolve()
    ])
      .then(() => {
        this.sdk.gameEventManager.notifyGame(WavedashEvents.STATS_STORED, {
          success: true
        } satisfies StatsStoredPayload);
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error
            ? error.message
            : `Error storing stats: ${error}`;
        logger.error(message);
        this.sdk.gameEventManager.notifyGame(WavedashEvents.STATS_STORED, {
          success: false,
          message
        } satisfies StatsStoredPayload);
      });
  }

  // ================
  // Stats
  // ================

  getStat(identifier: string): number {
    if (!this.isReady() || !this.knownStatIds.has(identifier)) return 0;
    return this.stats.get(identifier) ?? 0;
  }

  setStat(
    identifier: string,
    value: number,
    storeNow: boolean = false
  ): boolean {
    if (!this.isReady() || !this.knownStatIds.has(identifier)) return false;
    if (this.stats.get(identifier) !== value) {
      this.stats.set(identifier, value);
      this.dirtyStats.add(identifier);
      this.persistSender.schedule();
    }
    if (storeNow) this.persistSender.flush();
    return true;
  }

  // ================
  // Achievements
  // ================

  getAchievement(identifier: string): boolean {
    if (!this.isReady() || !this.knownAchievementIds.has(identifier))
      return false;
    return this.unlockedAchievements.has(identifier);
  }

  setAchievement(identifier: string, storeNow: boolean = false): boolean {
    if (!this.isReady() || !this.knownAchievementIds.has(identifier))
      return false;
    if (!this.unlockedAchievements.has(identifier)) {
      this.unlockedAchievements.add(identifier);
      this.dirtyAchievements.add(identifier);
      this.persistSender.schedule();
    }
    if (storeNow) this.persistSender.flush();
    return true;
  }

  /** @destructive - Returns the pending stats and achievements and resets the dirty collections */
  private getPendingData(): {
    stats: StatEntry[];
    achievements: string[];
  } | null {
    if (this.dirtyStats.size === 0 && this.dirtyAchievements.size === 0) {
      return null;
    }
    const stats: StatEntry[] = [...this.dirtyStats].map((id) => ({
      identifier: id,
      value: this.stats.get(id)!
    }));
    const achievements = [...this.dirtyAchievements];
    this.dirtyStats.clear();
    this.dirtyAchievements.clear();
    return { stats, achievements };
  }
}
