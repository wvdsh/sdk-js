import { ConvexClient } from "convex/browser";
import * as Constants from "./_generated/constants";
import * as remoteStorage from "./services/remoteStorage";
import * as leaderboards from "./services/leaderboards";
import * as ugc from "./services/ugc";
// TODO: Refactor all the services above to use Manager pattern we have for lobby and p2p
import { LobbyManager } from "./services/lobby";
import { P2PManager } from "./services/p2p";
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
  UGCVisibility,
  RemoteFileMetadata,
  P2PPeer,
  P2PConnection,
  P2PMessage,
  LobbyUsers,
  Signal
} from "./types";

class WavedashSDK {
  private initialized: boolean = false;

  protected config: WavedashConfig | null = null;
  protected wavedashUser: WavedashUser;
  protected p2pManager: P2PManager;
  protected lobbyManager: LobbyManager;
  
  convexClient: ConvexClient;
  engineCallbackReceiver: string = "WavedashCallbackReceiver";
  engineInstance: EngineInstance | null = null;
  logger: WavedashLogger;

  Constants = Constants;

  constructor(convexClient: ConvexClient, wavedashUser: WavedashUser) {
    this.convexClient = convexClient;
    this.wavedashUser = wavedashUser;
    this.logger = new WavedashLogger();
    this.p2pManager = new P2PManager(this);
    this.lobbyManager = new LobbyManager(this);
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
    
    // Update P2P manager configuration if provided
    if (this.config.p2p) {
      this.p2pManager.updateConfig(this.config.p2p);
    }
    
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

  /**
   * Downloads a remote file to a local location
   * @param filePath - The path of the remote file to download
   * @param downloadTo - Optionally provide a path to download the file to, defaults to the same path as the remote file
   * @returns The path of the local file that the remote file was downloaded to
   */
  async downloadRemoteFile(filePath: string): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Downloading remote file: ${filePath}`);
    const result = await remoteStorage.downloadRemoteFile.call(this, filePath);
    return this.formatResponse(result);
  }

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @param uploadTo - Optionally provide a path to upload the file to, defaults to the same path as the local file
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(filePath: string): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Uploading remote file: ${filePath}`);
    const result = await remoteStorage.uploadRemoteFile.call(this, filePath);
    return this.formatResponse(result);
  }

  /**
   * Lists a remote directory
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(path: string): Promise<string | WavedashResponse<RemoteFileMetadata[]>> {
    this.ensureReady();
    this.logger.debug(`Listing remote directory: ${path}`);
    const result = await remoteStorage.listRemoteDirectory.call(this, path);
    return this.formatResponse(result);
  }

  /**
   * Downloads a remote directory to a local location
   * @param path - The path of the remote directory to download
   * @returns The path of the local directory that the remote directory was downloaded to
   */
  async downloadRemoteDirectory(path: string): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Downloading remote directory: ${path}`);
    const result = await remoteStorage.downloadRemoteDirectory.call(this, path);
    return this.formatResponse(result);
  }

  // ============
  // P2P Networking
  // ============

  /**
   * Enable P2P networking for the current lobby
   * @param lobbyId - The lobby to enable P2P for
   * @param members - All lobby members for consistent peer handle generation
   * @returns P2P connection information
   */
  async enableP2P(lobbyId: Id<"lobbies">, members: WavedashUser[]): Promise<string | WavedashResponse<P2PConnection>> {
    this.ensureReady();
    this.logger.debug(`Enabling P2P for current lobby: ${lobbyId}`);
    const result = await this.p2pManager.initializeP2PForCurrentLobby(lobbyId, members);
    return this.formatResponse(result);
  }

  /**
   * Send a message through P2P to a specific peer using their handle
   * @param toHandle - Peer handle to send to (undefined = broadcast)
   * @param message - Message data
   * @param reliable - Use reliable channel (default: true)
   */
  async sendP2PMessage(toHandle: number | undefined, message: any, reliable: boolean = true): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug(`Sending P2P message to peer ${toHandle}, reliable: ${reliable}`);
    const result = await this.p2pManager.sendP2PMessage(toHandle, message, reliable);
    return this.formatResponse(result);
  }

  /**
   * Send high-frequency game data through P2P (uses unreliable channel)
   * @param toHandle - Peer handle to send to (undefined = broadcast)
   * @param data - Binary game data
   */
  async sendGameData(toHandle: number | undefined, data: ArrayBuffer): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug(`Sending game data to peer ${toHandle}`);
    const result = await this.p2pManager.sendGameData(toHandle, data);
    return this.formatResponse(result);
  }

  /**
   * Get peer information by handle
   * @param handle - The peer handle
   */
  getPeerByHandle(handle: number): P2PPeer | null {
    this.ensureReady();
    return this.p2pManager.getPeerByHandle(handle);
  }

  /**
   * Get the peer handle for a specific user
   * @param userId - The user ID to look up
   */
  getUserHandle(userId: Id<"users">): number | null {
    this.ensureReady();
    return this.p2pManager.getUserHandle(userId);
  }

  /**
   * Get the current P2P connection state
   */
  getCurrentP2PConnection(): P2PConnection | null {
    this.ensureReady();
    return this.p2pManager.getCurrentP2PConnection();
  }

  /**
   * Disconnect P2P for the current lobby
   */
  async disconnectP2P(): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    this.logger.debug('Disconnecting P2P for current lobby');
    const result = await this.p2pManager.disconnectP2P();
    return this.formatResponse(result);
  }

  /**
   * Set callback for receiving P2P messages (for web applications)
   * @param callback - Function to call when P2P messages are received
   */
  setP2PMessageCallback(callback: ((message: P2PMessage) => void) | null): void {
    this.ensureReady();
    this.p2pManager.setMessageCallback(callback);
  }

  /**
   * Check if a specific peer is ready for messaging
   * @param handle - The peer handle to check
   */
  isPeerReady(handle: number): boolean {
    this.ensureReady();
    return this.p2pManager.isPeerReady(handle);
  }

  /**
   * Get the connection status of all peers
   */
  getPeerStatuses(): Record<number, { reliable?: string; unreliable?: string; ready: boolean }> {
    this.ensureReady();
    return this.p2pManager.getPeerStatuses();
  }

  // ============
  // Game Lobbies
  // ============

  async createLobby(lobbyType: LobbyType, maxPlayers?: number): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug('Creating lobby with type:', lobbyType, 'and max players:', maxPlayers);
    const result = await this.lobbyManager.createLobby(lobbyType, maxPlayers);
    return this.formatResponse(result);
  }

  async joinLobby(lobbyId: Id<"lobbies">): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(`Joining lobby: ${lobbyId}`);
    const result = await this.lobbyManager.joinLobby(lobbyId);
    return this.formatResponse(result);
  }

  async getLobbyUsers(lobbyId: Id<"lobbies">): Promise<string | WavedashResponse<LobbyUsers>> {
    this.ensureReady();
    this.logger.debug(`Getting lobby users: ${lobbyId}`);
    const result = await this.lobbyManager.getLobbyUsers(lobbyId);
    return this.formatResponse(result);
  }

  async leaveLobby(lobbyId: Id<"lobbies">): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(`Leaving lobby: ${lobbyId}`);
    const result = await this.lobbyManager.leaveLobby(lobbyId);
    return this.formatResponse(result);
  }

  // Fire and forget, returns true if the message was sent out successfully
  // Game can listen for the LobbyMessage signal to get the message that was posted
  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    this.ensureReady();
    this.logger.debug(`Sending lobby message: ${message} to lobby: ${lobbyId}`);
    return this.lobbyManager.sendLobbyMessage(lobbyId, message);
  }

  // ==============================
  // JS -> Game Event Broadcasting
  // ==============================
  notifyGame(signal: Signal, payload: string | number | boolean | object): void {
    const toSend = typeof payload === 'object' ? JSON.stringify(payload) : payload;
    this.engineInstance?.SendMessage(
      this.engineCallbackReceiver,
      signal,
      toSend
    );
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

// export enums from types
export { GameEngine } from "./types";

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