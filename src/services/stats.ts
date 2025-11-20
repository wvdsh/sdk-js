import { api } from "@wvdsh/types";
import { WavedashResponse, WavedashSDK } from "..";
import unionBy from "lodash.unionby";

type Stats = Array<{ identifier: string; value: number }>;
type Achievements = Set<string>;

export class StatsManager {
  private sdk: WavedashSDK;
  private stats: Stats = [];
  private achievementIdentifiers: Achievements = new Set();

  private updatedStatIdentifiers: Set<string> = new Set();
  private updatedAchievementIdentifiers: Set<string> = new Set();

  private unsubscribeStats?: () => void;
  private unsubscribeAchievements?: () => void;
  private hasLoadedStats: boolean = false;
  private hasLoadedAchievements: boolean = false;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  ensureLoaded(): void {
    if (!this.hasLoadedStats || !this.hasLoadedAchievements) {
      throw new Error(
        "Stats and achievements not loaded, make sure to call requestStats() first"
      );
    }
  }

  async requestStats(): Promise<WavedashResponse<boolean>> {
    try {
      await Promise.all([
        new Promise((resolve, reject) => {
          this.unsubscribeStats = this.sdk.convexClient.onUpdate(
            api.gameAchievements.getMyStatsForGame,
            {},
            (newStats) => {
              this.hasLoadedStats = true;
              this.stats = unionBy(this.stats, newStats, "identifier");
              resolve(undefined);
            },
            (error) => {
              reject(error);
            }
          );
        }),
        new Promise((resolve, reject) => {
          this.unsubscribeAchievements = this.sdk.convexClient.onUpdate(
            api.gameAchievements.getMyAchievementsForGame,
            {},
            (achievements) => {
              this.hasLoadedAchievements = true;
              this.achievementIdentifiers = new Set([
                ...this.achievementIdentifiers,
                ...achievements.map(
                  ({ achievement }) => achievement.identifier
                ),
              ]);
              resolve(undefined);
            },
            (error) => {
              reject(error);
            }
          );
        }),
      ]);
      return {
        success: true,
        data: true,
        args: {},
      };
    } catch (error) {
      this.sdk.logger.error(`Error requesting stats: ${error}`);
      return {
        success: false,
        data: false,
        args: {},
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async storeStats(): Promise<WavedashResponse<boolean>> {
    try {
      this.ensureLoaded();
      const updatedStats = this.stats.filter((stat) =>
        this.updatedStatIdentifiers.has(stat.identifier)
      );
      if (updatedStats.length > 0) {
        await this.sdk.convexClient.mutation(
          api.gameAchievements.setUserGameStats,
          { stats: updatedStats }
        );
      }

      const updatedAchievements = Array.from(
        this.achievementIdentifiers
      ).filter((achievement) =>
        this.updatedAchievementIdentifiers.has(achievement)
      );
      if (updatedAchievements.length > 0) {
        await this.sdk.convexClient.mutation(
          api.gameAchievements.setUserGameAchievements,
          { achievements: updatedAchievements }
        );
      }

      this.updatedStatIdentifiers.clear();
      this.updatedAchievementIdentifiers.clear();
      return {
        success: true,
        data: true,
        args: {},
      };
    } catch (error) {
      this.sdk.logger.error(`Error storing stats: ${error}`);
      return {
        success: false,
        data: false,
        args: {},
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  setAchievement(identifier: string): void {
    this.ensureLoaded();
    if (!this.achievementIdentifiers.has(identifier)) {
      this.achievementIdentifiers.add(identifier);
      this.updatedAchievementIdentifiers.add(identifier);
    }
  }

  getAchievement(identifier: string): boolean {
    this.ensureLoaded();
    return this.achievementIdentifiers.has(identifier);
  }

  setStat(identifier: string, value: number): void {
    this.ensureLoaded();
    const stat = this.stats.find((s) => s.identifier === identifier);
    if (stat) {
      if (stat.value !== value) {
        stat.value = value;
        this.updatedStatIdentifiers.add(identifier);
      }
    } else {
      this.stats.push({ identifier, value });
      this.updatedStatIdentifiers.add(identifier);
    }
  }

  getStat(identifier: string): number {
    this.ensureLoaded();
    const stat = this.stats.find((s) => s.identifier === identifier);
    const value = stat ? stat.value : -1;
    return value;
  }
}
