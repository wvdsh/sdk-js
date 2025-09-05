import { ConvexClient } from "convex/browser";
import * as remoteStorage from "./services/remoteStorage";
import * as Constants from "./_generated/constants";
import * as leaderboards from "./services/leaderboards";
import * as ugc from "./services/ugc";
import * as lobby from "./services/lobby";
import { WavedashLogger, LOG_LEVEL } from "./utils/logger";
import type {
  Id,
  LobbyType,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  WavedashConfig,
  WavedashUser,
  EngineInstance,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry,
  UGCType,
  UGCVisibility
} from "./types";

class WavedashSDK {
  private initialized: boolean = false;
  protected config: WavedashConfig | null = null;
  
  protected engineCallbackReceiver: string = "WavedashCallbackReceiver";
  protected engineInstance: EngineInstance | null = null;
  protected wavedashUser: WavedashUser;
  protected convexClient: ConvexClient;
  protected logger: WavedashLogger;

  Constants = Constants;

  constructor(convexClient: ConvexClient, wavedashUser: WavedashUser) {
    this.convexClient = convexClient;
    this.wavedashUser = wavedashUser;
    this.logger = new WavedashLogger();
  }

  // =============
  // Setup methods
  // =============

  init(config: WavedashConfig): boolean {
    if (!config) {
      this.logger.error('Initialized with empty config');
      return false;
    }
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      }
      catch (error) {
        this.logger.error('Initialized with invalid config:', error);
        return false;
      }
    }

    this.config = config;
    this.initialized = true;

    // Update logger debug mode based on config
    this.logger.setLogLevel(this.config.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);
    this.logger.debug('Initialized with config:', this.config);
    return true;
  }

  /**
   * Set the engine instance (Unity or Godot).
   * If using a game engine, call this function before starting the game.
   * @param engineInstance - The engine instance.
   */
  setEngineInstance(engineInstance: EngineInstance): void {
    this.engineInstance = engineInstance;
  }

  isReady(): boolean {
    return this.initialized;
  }

  // ============
  // User methods
  // ============

  getUser(): string | WavedashUser {
    this.ensureReady();
    return this.formatResponse(this.wavedashUser);
  }

  getUsername(): string {
    this.ensureReady();
    return this.wavedashUser.username;
  }

  getUserId(): Id<"users"> {
    this.ensureReady();
    return this.wavedashUser.id;
  }

  // ============
  // Leaderboards
  // ============

  // TODO: Function wrappers to factor out the common logic here
  async getLeaderboard(name: string): Promise<string | WavedashResponse<Leaderboard>> {
    this.ensureReady();
    this.logger.debug(`Getting leaderboard: ${name}`);
    const result = await leaderboards.getLeaderboard.call(this, name);
    return this.formatResponse(result);
  }

  async getOrCreateLeaderboard(name: string, sortOrder: LeaderboardSortOrder, displayType: LeaderboardDisplayType): Promise<string | WavedashResponse<Leaderboard>> {
    this.ensureReady();
    this.logger.debug(`Getting or creating leaderboard: ${name}`);
    const result = await leaderboards.getOrCreateLeaderboard.call(this, name, sortOrder, displayType);
    return this.formatResponse(result);
  }

  // Synchronously get leaderboard entry count from cache
  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    this.ensureReady();
    this.logger.debug(`Getting leaderboard entry count for leaderboard: ${leaderboardId}`);
    return leaderboards.getLeaderboardEntryCount.call(this, leaderboardId);
  }

  // This is called get my "entries" but under the hood we enforce one entry per user
  // The engine SDK expects a list of entries, so we return a list with 0 or 1 entries
  async getMyLeaderboardEntries(leaderboardId: Id<"leaderboards">): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(`Getting logged in user's leaderboard entry for leaderboard: ${leaderboardId}`);
    const result = await leaderboards.getMyLeaderboardEntries.call(this, leaderboardId);
    return this.formatResponse(result);
  }

  async listLeaderboardEntriesAroundUser(leaderboardId: Id<"leaderboards">, countAhead: number, countBehind: number): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(`Listing entries around user for leaderboard: ${leaderboardId}`);
    const result = await leaderboards.listLeaderboardEntriesAroundUser.call(this, leaderboardId, countAhead, countBehind);
    return this.formatResponse(result);
  }

  async listLeaderboardEntries(leaderboardId: Id<"leaderboards">, offset: number, limit: number): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(`Listing entries for leaderboard: ${leaderboardId}`);
    const result = await leaderboards.listLeaderboardEntries.call(this, leaderboardId, offset, limit);
    return this.formatResponse(result);
  }

  async uploadLeaderboardScore(leaderboardId: Id<"leaderboards">, score: number, keepBest: boolean, ugcId?: Id<"userGeneratedContent">): Promise<string | WavedashResponse<UpsertedLeaderboardEntry>> {
    this.ensureReady();
    this.logger.debug(`Uploading score ${score} to leaderboard: ${leaderboardId}`);
    const result = await leaderboards.uploadLeaderboardScore.call(this, leaderboardId, score, keepBest, ugcId);
    return this.formatResponse(result);
  }

  // ======================
  // USER GENERATED CONTENT
  // ======================

  /**
   * Creates a new UGC item and uploads the file to the server if a filePath is provided
   * @param ugcType 
   * @param title 
   * @param description 
   * @param visibility 
   * @param filePath - optional IndexedDB key file path to upload to the server. If not provided, the UGC item will be created but no file will be uploaded.
   * @returns ugcId
   */
  async createUGCItem(ugcType: UGCType, title?: string, description?: string, visibility?: UGCVisibility, filePath?: string): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(`Creating UGC item of type: ${ugcType} ${filePath ? `from file: ${filePath}` : ''}`);
    const result = await ugc.createUGCItem.call(this, ugcType, title, description, visibility, filePath);
    return this.formatResponse(result);
  }

  /**
   * Updates a UGC item and uploads the file to the server if a filePath is provided
   * TODO: GD Script cannot call with optional arguments, convert this to accept a single dictionary of updates
   * @param ugcId 
   * @param title 
   * @param description 
   * @param visibility 
   * @param filePath - optional IndexedDB key file path to upload to the server. If not provided, the UGC item will be updated but no file will be uploaded.
   * @returns ugcId
   */
  async updateUGCItem(ugcId: Id<"userGeneratedContent">, title?: string, description?: string, visibility?: UGCVisibility, filePath?: string): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(`Updating UGC item: ${ugcId} ${filePath ? `from file: ${filePath}` : ''}`);
    const result = await ugc.updateUGCItem.call(this, ugcId, title, description, visibility, filePath);
    return this.formatResponse(result);
  }

  async downloadUGCItem(ugcId: Id<"userGeneratedContent">, filePath: string): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(`Downloading UGC item: ${ugcId} to: ${filePath}`);
    const result = await ugc.downloadUGCItem.call(this, ugcId, filePath);
    return this.formatResponse(result);
  }

  // ================================
  // Save state / Remote File Storage
  // ================================

  async remoteFileExists(filePath: string): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug(`Checking if remote file exists: ${filePath}`);
    const result = await remoteStorage.remoteFileExists.call(this, filePath);
    return this.formatResponse(result);
  }

  async downloadRemoteFile(filePath: string): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Downloading remote file: ${filePath}`);
    const result = await remoteStorage.downloadRemoteFile.call(this, filePath);
    return this.formatResponse(result);
  }

  async uploadRemoteFile(filePath: string): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Uploading remote file: ${filePath}`);
    const result = await remoteStorage.uploadRemoteFile.call(this, filePath);
    return this.formatResponse(result);
  }

  async remoteFileLastUpdatedAt(filePath: string): Promise<string | WavedashResponse<number>> {
    this.ensureReady();
    this.logger.debug(`Getting last updated at for remote file: ${filePath}`);
    const result = await remoteStorage.remoteFileLastUpdatedAt.call(this, filePath);
    return this.formatResponse(result);
  }

  // ============
  // Game Lobbies
  // ============

  async createLobby(lobbyType: LobbyType, maxPlayers?: number): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug('Creating lobby with type:', lobbyType, 'and max players:', maxPlayers);
    const result = await lobby.createLobby.call(this, lobbyType, maxPlayers);
    return this.formatResponse(result);
  }

  async joinLobby(lobbyId: Id<"lobbies">): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(`Joining lobby: ${lobbyId}`);
    const result = await lobby.joinLobby.call(this, lobbyId);
    return this.formatResponse(result);
  }

  async leaveLobby(lobbyId: Id<"lobbies">): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug(`Leaving lobby: ${lobbyId}`);
    const result = await lobby.leaveLobby.call(this, lobbyId);
    return this.formatResponse(result);
  }

  // TODO: Consider returning the parsed message from the server rather than a boolean
  async sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug(`Sending lobby message: ${message} to lobby: ${lobbyId}`);
    const result = await lobby.sendLobbyMessage.call(this, lobbyId, message);
    return this.formatResponse(result);
  }

  // ================
  // Internal Helpers
  // ================

  private isGodot(): boolean {
    return this.engineInstance !== null && this.engineInstance.type === "GODOT";
  }

  // Helper to format response based on context
  // Godot callbacks expect a string, so we need to format the response accordingly
  private formatResponse<T>(data: T): T | string {
    return this.isGodot() ? JSON.stringify(data) : data;
  }

  // Helper to ensure SDK is ready, throws if not
  private ensureReady(): void {
    if (!this.isReady()) {
      this.logger.warn('SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
  }
}

// =======
// Exports
// =======

export { WavedashSDK };

// Re-export all types
export type * from "./types";

// Type-safe initialization helper
export function setupWavedashSDK(
  convexClient: ConvexClient,
  wavedashUser: WavedashUser,
): WavedashSDK {
  const sdk = new WavedashSDK(convexClient, wavedashUser);

  if (typeof window !== 'undefined') {
    (window as any).WavedashJS = sdk;
    console.log('[WavedashJS] SDK attached to window');
  }


  return sdk;
}