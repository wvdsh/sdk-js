import { WavedashResponse, WavedashSDK } from "..";
import { api } from "../_generated/convex_api";
import unionBy from "lodash.unionby";

type Stats = Array<{ identifier: string; value: number }>;
type Achievements = Set<string>;

export class AchievementsManager {
  private sdk: WavedashSDK;
  private stats: Stats = [];
  private achievements: Achievements = new Set();

  private updatedStatIdentifiers: Set<string> = new Set();
  private updatedAchievementIdentifiers: Set<string> = new Set();

  private unsubscribeStats?: () => void;
  private unsubscribeAchievements?: () => void;
  private hasLoadedStats: boolean = false;
  private hasLoadedAchievements: boolean = false;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async requestStats() {
    this.unsubscribeStats = this.sdk.convexClient.onUpdate(
      api.gameAchievements.getMyStatsForGame,
      {},
      (newStats) => {
        this.hasLoadedStats = true;
        this.stats = unionBy(this.stats, newStats, "identifier");
      }
    );

    this.unsubscribeAchievements = this.sdk.convexClient.onUpdate(
      api.gameAchievements.getMyAchievementsForGame,
      {},
      (achievements) => {
        this.hasLoadedAchievements = true;
        this.achievements = new Set([...this.achievements, ...achievements]);
      }
    );
  }

  async storeStats() {
    const updatedStats = this.stats.filter((stat) =>
      this.updatedStatIdentifiers.has(stat.identifier)
    );
    if (updatedStats.length > 0) {
      await this.sdk.convexClient.mutation(
        api.gameAchievements.setUserGameStats,
        { stats: updatedStats }
      );
    }

    const updatedAchievements = Array.from(this.achievements).filter(
      (achievement) => this.updatedAchievementIdentifiers.has(achievement)
    );
    if (updatedAchievements.length > 0) {
      await this.sdk.convexClient.mutation(
        api.gameAchievements.setUserGameAchievements,
        { achievements: updatedAchievements }
      );
    }

    this.updatedStatIdentifiers.clear();
    this.updatedAchievementIdentifiers.clear();
  }

  setAchievement(identifier: string): void {
    if (!this.achievements.has(identifier)) {
      this.achievements.add(identifier);
      this.updatedAchievementIdentifiers.add(identifier);
    }
  }

  getAchievement(identifier: string): boolean {
    return this.achievements.has(identifier);
  }

  setStat(identifier: string, value: number): void {
    const stat = this.stats.find((s) => s.identifier === identifier);
    if (stat && stat.value !== value) {
      stat.value = value;
      this.updatedStatIdentifiers.add(identifier);
    } else {
      this.stats.push({ identifier, value });
      this.updatedStatIdentifiers.add(identifier);
    }
  }

  getStat(identifier: string): number {
    const stat = this.stats.find((s) => s.identifier === identifier);
    const value = stat ? stat.value : -1;
    return value;
  }
}
