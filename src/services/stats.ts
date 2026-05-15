import { api } from "@wvdsh/api";
import type { WavedashSDK } from "..";
import type { StatsStoredPayload } from "../types";
import { WavedashEvents } from "../events";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import throttle from "lodash.throttle";

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

  // Single in-flight persist mutation; prevents OCC self-conflicts.
  private inFlightPersist: Promise<unknown> | null = null;

  // Set when a storeNow flush hits the in-flight gate; persist's .finally()
  // checks this and fires immediately on the next cycle instead of waiting
  // out the throttle window. (lodash treats the gated flush as a successful
  // invocation, so without this flag a contended storeNow waits ~THROTTLE_MS.)
  private flushRequested = false;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.subscribe();
    this.requestStats().catch((error) => {
      logger.error("Initial stats fetch failed:", error);
    });
  }

  destroy(): void {
    this.throttledPersist.cancel();
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
        api.sdk.gameAchievements.listStatIdentifiers,
        {},
        (ids) => {
          this.knownStatIds = new Set(ids);
        },
        (error) => {
          logger.error("Stat identifiers subscription error:", error);
        }
      ),
      this.sdk.convexClient.onUpdate(
        api.sdk.gameAchievements.listAchievementIdentifiers,
        {},
        (ids) => {
          this.knownAchievementIds = new Set(ids);
        },
        (error) => {
          logger.error(
            "Achievement identifiers subscription error:",
            error
          );
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
  // setter; trailing: true to flush coalesced edits at the end of the window.
  // storeNow=true (and storeStats()) call .flush() to fire the pending invocation
  // immediately. The in-flight gate in persist() covers mutations that outlast
  // the throttle window, which would otherwise overlap and cause OCC conflicts.
  private throttledPersist = throttle(
    () => this.persist(),
    STORE_THROTTLE_MS,
    { leading: false, trailing: true }
  );

  storeStats(): boolean {
    if (!this.isReady()) return false;
    this.throttledPersist();
    this.requestPersistFlush();
    return true;
  }

  // Force-fire the throttled persist now. If a mutation is already in flight,
  // the gate will swallow the flush(), so we also flag flushRequested so the
  // next .finally() flushes again instead of waiting a full throttle window.
  private requestPersistFlush(): void {
    if (this.inFlightPersist !== null) this.flushRequested = true;
    this.throttledPersist.flush();
  }

  private persist(): void {
    // Skip if a mutation is already in flight; .finally() will reschedule.
    if (this.inFlightPersist !== null) return;
    if (this.dirtyStats.size === 0 && this.dirtyAchievements.size === 0) return;

    const pending = this.getPendingData();
    if (!pending) return;

    this.inFlightPersist = Promise.all([
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
      })
      .finally(() => {
        this.inFlightPersist = null;
        const shouldFlushNow = this.flushRequested;
        this.flushRequested = false;
        if (this.dirtyStats.size > 0 || this.dirtyAchievements.size > 0) {
          this.throttledPersist();
          if (shouldFlushNow) this.throttledPersist.flush();
        }
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
      this.throttledPersist();
    }
    if (storeNow) this.requestPersistFlush();
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
      this.throttledPersist();
    }
    if (storeNow) this.requestPersistFlush();
    return true;
  }

  /** @destructive - Returns the pending stats and achievements and resets the dirty collections */
  private getPendingData(): { stats: StatEntry[]; achievements: string[] } | null {
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
