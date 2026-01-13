import { ConvexClient } from "convex/browser";
import { LobbyManager } from "./services/lobby";
import { FileSystemManager } from "./services/fileSystem";
import { UGCManager } from "./services/ugc";
import { LeaderboardManager } from "./services/leaderboards";
import { P2PManager } from "./services/p2p";
import { StatsManager } from "./services/stats";
import { HeartbeatManager } from "./services/heartbeat";
import { WavedashLogger, LOG_LEVEL } from "./utils/logger";
import { IFrameMessenger } from "./utils/iframeMessenger";
import { takeFocus } from "./utils/focusManager";

// Create singleton instance for iframe messaging
const iframeMessenger = new IFrameMessenger();

import type {
  Id,
  LobbyVisibility,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  WavedashConfig,
  EngineInstance,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry,
  UGCType,
  UGCVisibility,
  RemoteFileMetadata,
  P2PMessage,
  LobbyUser,
  Signal,
  Lobby
} from "./types";
import {
  GAME_ENGINE,
  IFRAME_MESSAGE_TYPE,
  SDKConfig,
  SDKUser
} from "@wvdsh/types";

class WavedashSDK {
  private initialized: boolean = false;
  private lobbyIdToJoinOnStartup?: Id<"lobbies">;
  private sessionEndSent: boolean = false;

  config: WavedashConfig | null = null;
  wavedashUser: SDKUser;
  gameCloudId: string;
  protected ugcHost: string;
  protected lobbyManager: LobbyManager;
  protected statsManager: StatsManager;
  protected heartbeatManager: HeartbeatManager;
  protected ugcManager: UGCManager;
  protected leaderboardManager: LeaderboardManager;
  fileSystemManager: FileSystemManager;

  private convexHttpUrl: string;

  convexClient: ConvexClient;
  engineCallbackReceiver: string = "WavedashCallbackReceiver";
  engineInstance: EngineInstance | null = null;
  logger: WavedashLogger;
  iframeMessenger: IFrameMessenger;
  p2pManager: P2PManager;
  gameplayJwt: string | null = null;

  constructor(sdkConfig: SDKConfig) {
    const convexClient = new ConvexClient(sdkConfig.convexCloudUrl);
    convexClient.setAuth(() => this.getAuthToken());
    this.convexClient = convexClient;
    this.convexHttpUrl = sdkConfig.convexHttpUrl;
    this.wavedashUser = sdkConfig.wavedashUser;
    this.gameCloudId = sdkConfig.gameCloudId;
    this.ugcHost = sdkConfig.ugcHost;
    this.logger = new WavedashLogger();
    this.p2pManager = new P2PManager(this);
    this.lobbyManager = new LobbyManager(this);
    this.statsManager = new StatsManager(this);
    this.heartbeatManager = new HeartbeatManager(this);
    this.fileSystemManager = new FileSystemManager(this);
    this.ugcManager = new UGCManager(this);
    this.leaderboardManager = new LeaderboardManager(this);
    this.iframeMessenger = iframeMessenger;

    this.setupSessionEndListeners();

    // TODO: Add event queueing system to handle events that happen before the game is ready for events
    // For now this is the only event we need to wait on, so just triggering it as soon as the game is ready
    this.lobbyIdToJoinOnStartup = sdkConfig.lobbyIdToJoin;
  }

  private async getAuthToken(): Promise<string> {
    this.gameplayJwt = await iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.GET_AUTH_TOKEN
    );
    return this.gameplayJwt;
  }

  /**
   * Set up listeners for page unload events to end gameplay session.
   * Uses both beforeunload and pagehide for maximum reliability.
   */
  private setupSessionEndListeners(): void {
    // warm up the preflight cache
    const endSessionEndpoint = `${this.convexHttpUrl}/gameplay/end-session`;
    fetch(endSessionEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.gameplayJwt}`
      },
      body: JSON.stringify({ _type: "warmup" }),
      credentials: "include"
    }).catch(() => {});

    const endGameplaySession = (
      _event: PageTransitionEvent | BeforeUnloadEvent
    ) => {
      if (this.sessionEndSent) return;
      this.sessionEndSent = true;

      this.lobbyManager.unsubscribeFromCurrentLobby();
      const pendingData = this.statsManager.getPendingData();
      const sessionEndData: Record<string, unknown> = {};
      if (pendingData?.stats?.length) {
        sessionEndData.stats = pendingData.stats;
      }
      if (pendingData?.achievements?.length) {
        sessionEndData.achievements = pendingData.achievements;
      }

      fetch(endSessionEndpoint, {
        method: "POST",
        body: JSON.stringify(sessionEndData),
        keepalive: true,
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.gameplayJwt}`
        }
      });
    };

    window.addEventListener("beforeunload", endGameplaySession);
    window.addEventListener("pagehide", endGameplaySession);
  }

  // =============
  // Setup methods
  // =============

  init(config: WavedashConfig): boolean {
    if (!config) {
      this.logger.error("Initialized with empty config");
      return false;
    }
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch (error) {
        this.logger.error("Initialized with invalid config:", error);
        return false;
      }
    }

    this.config = config;
    this.initialized = true;

    // Update logger debug mode based on config
    this.logger.setLogLevel(
      this.config.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN
    );

    // Update P2P manager configuration if provided
    if (this.config.p2p) {
      this.p2pManager.updateConfig(this.config.p2p);
    }

    this.logger.debug("Initialized with config:", this.config);
    // Start heartbeat service
    this.heartbeatManager.start();

    // Join a lobby on startup if provided
    if (this.lobbyIdToJoinOnStartup && !this.config.deferEvents) {
      this.joinLobby(this.lobbyIdToJoinOnStartup).catch((error) => {
        this.logger.error("Could not join lobby on startup:", error);
      });
    }

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

  readyForEvents(): void {
    this.ensureReady();
    if (!this.config?.deferEvents) {
      return;
    }
    this.config!.deferEvents = false;
    // Game is now ready for event messages, join a lobby if provided, SDK will send LOBBY_JOINED signal on success
    if (this.lobbyIdToJoinOnStartup) {
      this.joinLobby(this.lobbyIdToJoinOnStartup).catch((error) => {
        this.logger.error("Could not join lobby on startup:", error);
      });
    }
  }

  toggleOverlay(): void {
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.TOGGLE_OVERLAY, {});
  }

  // ============
  // User methods
  // ============

  getUser(): string | SDKUser {
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

  async getLeaderboard(
    name: string
  ): Promise<string | WavedashResponse<Leaderboard>> {
    this.ensureReady();
    this.logger.debug(`Getting leaderboard: ${name}`);
    const result = await this.leaderboardManager.getLeaderboard(name);
    return this.formatResponse(result);
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<string | WavedashResponse<Leaderboard>> {
    this.ensureReady();
    this.logger.debug(`Getting or creating leaderboard: ${name}`);
    const result = await this.leaderboardManager.getOrCreateLeaderboard(
      name,
      sortOrder,
      displayType
    );
    return this.formatResponse(result);
  }

  // Synchronously get leaderboard entry count from cache
  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    this.ensureReady();
    this.logger.debug(
      `Getting leaderboard entry count for leaderboard: ${leaderboardId}`
    );
    return this.leaderboardManager.getLeaderboardEntryCount(leaderboardId);
  }

  // This is called get my "entries" but under the hood we enforce one entry per user
  // The engine SDK expects a list of entries, so we return a list with 0 or 1 entries
  async getMyLeaderboardEntries(
    leaderboardId: Id<"leaderboards">
  ): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(
      `Getting logged in user's leaderboard entry for leaderboard: ${leaderboardId}`
    );
    const result =
      await this.leaderboardManager.getMyLeaderboardEntries(leaderboardId);
    return this.formatResponse(result);
  }

  async listLeaderboardEntriesAroundUser(
    leaderboardId: Id<"leaderboards">,
    countAhead: number,
    countBehind: number
  ): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(
      `Listing entries around user for leaderboard: ${leaderboardId}`
    );
    const result =
      await this.leaderboardManager.listLeaderboardEntriesAroundUser(
        leaderboardId,
        countAhead,
        countBehind
      );
    return this.formatResponse(result);
  }

  async listLeaderboardEntries(
    leaderboardId: Id<"leaderboards">,
    offset: number,
    limit: number
  ): Promise<string | WavedashResponse<LeaderboardEntries>> {
    this.ensureReady();
    this.logger.debug(`Listing entries for leaderboard: ${leaderboardId}`);
    const result = await this.leaderboardManager.listLeaderboardEntries(
      leaderboardId,
      offset,
      limit
    );
    return this.formatResponse(result);
  }

  async uploadLeaderboardScore(
    leaderboardId: Id<"leaderboards">,
    score: number,
    keepBest: boolean,
    ugcId?: Id<"userGeneratedContent">
  ): Promise<string | WavedashResponse<UpsertedLeaderboardEntry>> {
    this.ensureReady();
    this.logger.debug(
      `Uploading score ${score} to leaderboard: ${leaderboardId}`
    );
    const result = await this.leaderboardManager.uploadLeaderboardScore(
      leaderboardId,
      score,
      keepBest,
      ugcId
    );
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
  async createUGCItem(
    ugcType: UGCType,
    title?: string,
    description?: string,
    visibility?: UGCVisibility,
    filePath?: string
  ): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(
      `Creating UGC item of type: ${ugcType} ${filePath ? `from file: ${filePath}` : ""}`
    );
    const result = await this.ugcManager.createUGCItem(
      ugcType,
      title,
      description,
      visibility,
      filePath
    );
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
  async updateUGCItem(
    ugcId: Id<"userGeneratedContent">,
    title?: string,
    description?: string,
    visibility?: UGCVisibility,
    filePath?: string
  ): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(
      `Updating UGC item: ${ugcId} ${filePath ? `from file: ${filePath}` : ""}`
    );
    const result = await this.ugcManager.updateUGCItem(
      ugcId,
      title,
      description,
      visibility,
      filePath
    );
    return this.formatResponse(result);
  }

  async downloadUGCItem(
    ugcId: Id<"userGeneratedContent">,
    filePath: string
  ): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    this.ensureReady();
    this.logger.debug(`Downloading UGC item: ${ugcId} to: ${filePath}`);
    const result = await this.ugcManager.downloadUGCItem(ugcId, filePath);
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
  async downloadRemoteFile(
    filePath: string
  ): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Downloading remote file: ${filePath}`);
    const result = await this.fileSystemManager.downloadRemoteFile(filePath);
    return this.formatResponse(result);
  }

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @param uploadTo - Optionally provide a path to upload the file to, defaults to the same path as the local file
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(
    filePath: string
  ): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Uploading remote file: ${filePath}`);
    const result = await this.fileSystemManager.uploadRemoteFile(filePath);
    return this.formatResponse(result);
  }

  /**
   * Lists a remote directory
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(
    path: string
  ): Promise<string | WavedashResponse<RemoteFileMetadata[]>> {
    this.ensureReady();
    this.logger.debug(`Listing remote directory: ${path}`);
    const result = await this.fileSystemManager.listRemoteDirectory(path);
    return this.formatResponse(result);
  }

  /**
   * Downloads a remote directory to a local location
   * @param path - The path of the remote directory to download
   * @returns The path of the local directory that the remote directory was downloaded to
   */
  async downloadRemoteDirectory(
    path: string
  ): Promise<string | WavedashResponse<string>> {
    this.ensureReady();
    this.logger.debug(`Downloading remote directory: ${path}`);
    const result = await this.fileSystemManager.downloadRemoteDirectory(path);
    return this.formatResponse(result);
  }

  /**
   * Persists data to local file storage (IndexeDB).
   * For use in pure JS games.
   * Games built from engines should use their engine's builtin File API to read and write files.
   * @param filePath - The path of the local file to write
   * @param data - The data to write to the local file (byte array)
   * @returns true if the file was written successfully
   */
  async writeLocalFile(
    filePath: string,
    data: Uint8Array
  ): Promise<boolean> {
    this.ensureReady();
    this.logger.debug(`Writing local file: ${filePath}`);
    const result = await this.fileSystemManager.writeLocalFile(filePath, data);
    return result;
  }

  /**
   * Reads data from local file storage (IndexedDB).
   * For use in pure JS games.
   * Games built from engines should use their engine's builtin File API to read and write files.
   * @param filePath - The path of the local file to read
   * @returns The data read from the local file (byte array)
   */
  async readLocalFile(
    filePath: string
  ): Promise<Uint8Array | null> {
    this.ensureReady();
    this.logger.debug(`Reading local file: ${filePath}`);
    const result = await this.fileSystemManager.readLocalFile(filePath);
    return result;
  }

  // ============
  // Achievements + Stats
  // ============
  getAchievement(identifier: string): boolean {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return false;
    }
    return this.statsManager.getAchievement(identifier);
  }
  getStat(identifier: string): number {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return 0;
    }
    return this.statsManager.getStat(identifier);
  }
  setAchievement(identifier: string): void {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return;
    }
    this.statsManager.setAchievement(identifier);
  }
  setStat(identifier: string, value: number): void {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return;
    }
    this.statsManager.setStat(identifier, value);
  }
  async requestStats(): Promise<string | WavedashResponse<boolean>> {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return this.formatResponse({
        success: false,
        data: false,
        args: {}
      });
    }
    return this.formatResponse(await this.statsManager.requestStats());
  }
  storeStats(): boolean {
    this.ensureReady();
    if (this.config?.disableAchievementsAndStats) {
      return false;
    }
    return this.statsManager.storeStats();
  }

  // ============
  // P2P Networking
  // ============

  /**
   * Get a pre-allocated scratch buffer for outgoing messages
   * @returns A Uint8Array buffer that can your game can write the binary payload to before calling sendP2PMessage
   */
  getP2POutgoingMessageBuffer(): Uint8Array {
    this.ensureReady();
    return this.p2pManager.getOutgoingMessageBuffer();
  }

  /**
   * Send a message through P2P to a specific peer using their userId
   * @param toUserId - Peer userId to send to (undefined = broadcast)
   * @param appChannel - Optional channel for message routing. All messages still use the same P2P connection under the hood.
   * @param reliable - Send reliably, meaning guaranteed delivery and ordering, but slower (default: true)
   * @param payload - The payload to send (byte array)
   * @param payloadSize - How many bytes from the payload to send. Defaults to payload.length (the entire payload)
   * @returns true if the message was sent out successfully
   */
  sendP2PMessage(
    toUserId: Id<"users"> | undefined,
    appChannel: number = 0,
    reliable: boolean = true,
    payload: Uint8Array,
    payloadSize: number = payload.length
  ): boolean {
    this.ensureReady();
    if (toUserId && !this.p2pManager.isPeerReady(toUserId)) {
      return false;
    } else if (!toUserId && !this.p2pManager.isBroadcastReady()) {
      return false;
    }
    return this.p2pManager.sendP2PMessage(
      toUserId,
      appChannel,
      reliable,
      payload,
      payloadSize
    );
  }

  /**
   * Send the same payload to all peers in the lobby
   * @param appChannel - Optional app-level channel for message routing. All messages still use the same P2P connection under the hood.
   * @param reliable - Send reliably, meaning guaranteed delivery and ordering, but slower (default: true)
   * @param payload - The payload to send (byte array)
   * @param payloadSize - How many bytes from the payload to send. Defaults to payload.length (the entire payload)
   * @returns true if the message was sent out successfully
   */
  broadcastP2PMessage(
    appChannel: number = 0,
    reliable: boolean = true,
    payload: Uint8Array,
    payloadSize: number = payload.length
  ): boolean {
    this.ensureReady();
    if (!this.p2pManager.isBroadcastReady()) {
      return false;
    }
    return this.p2pManager.sendP2PMessage(
      undefined,
      appChannel,
      reliable,
      payload,
      payloadSize
    );
  }

  /**
   * Read one binary message from a specific P2P message channel
   * @param appChannel - The channel to read from
   * @returns To Game Engine: Uint8Array (zero-copy view, empty if no message available)
   *          To JS: P2PMessage (null if no message available)
   */
  readP2PMessageFromChannel(
    appChannel: number
  ): Uint8Array | P2PMessage | null {
    this.ensureReady();
    // Should we return a copy of the binary data rather than a data view?
    // We're assuming the engine makes its own copy of the binary data when calling this function
    // If we ever see race conditions, make this a copy, but for performance, we're returning a view
    const returnRawBinary = this.engineInstance ? true : false;
    return this.p2pManager.readMessageFromChannel(appChannel, returnRawBinary);
  }

  /**
   * Drain all messages from a P2P channel into a buffer
   * Data will be presented in a tightly packed format: [size:4 bytes][msg:N bytes][size:4 bytes][msg:N bytes]...
   * JS games can just use readP2PMessageFromChannel to get decoded P2PMessages
   * Game engines should use drainP2PChannelToBuffer for better performance
   * @param appChannel - The channel to drain
   * @param buffer - The buffer to drain the messages into.
   *  If provided, the buffer will be filled until full, any remaining messages will be left in the queue.
   *  If not provided, a new buffer with all messages will be created and returned.
   * @returns A Uint8Array containing each message in a tightly packed format: [size:4 bytes][msg:N bytes][size:4 bytes][msg:N bytes]...
   */
  drainP2PChannelToBuffer(appChannel: number, buffer?: Uint8Array): Uint8Array {
    this.ensureReady();
    return this.p2pManager.drainChannelToBuffer(appChannel, buffer);
  }

  /**
   * Check if a specific peer is ready for messaging
   * @param userId - The peer user ID to check
   */
  isPeerReady(userId: Id<"users">): boolean {
    this.ensureReady();
    return this.p2pManager.isPeerReady(userId);
  }

  /**
   * Check if the broadcast is ready for messaging
   * @returns true if at least one peer is ready for messaging
   */
  isBroadcastReady(): boolean {
    this.ensureReady();
    return this.p2pManager.isBroadcastReady();
  }

  // ============
  // Game Lobbies
  // ============

  async createLobby(
    visibility: LobbyVisibility,
    maxPlayers?: number
  ): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(
      "Creating lobby with visibility:",
      visibility,
      "and max players:",
      maxPlayers
    );
    const result = await this.lobbyManager.createLobby(visibility, maxPlayers);
    return this.formatResponse(result);
  }

  /**
   * Join a lobby
   * @param lobbyId - The ID of the lobby to join
   * @returns A WavedashResponse containing the lobby ID
   * @emits LOBBY_JOINED signal to the game engine
   */
  async joinLobby(
    lobbyId: Id<"lobbies">
  ): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(`Joining lobby: ${lobbyId}`);
    const result = await this.lobbyManager.joinLobby(lobbyId);
    return this.formatResponse(result);
  }

  async listAvailableLobbies(
    friendsOnly: boolean = false
  ): Promise<string | WavedashResponse<Lobby[]>> {
    this.ensureReady();
    this.logger.debug(`Listing available lobbies`);
    const result = await this.lobbyManager.listAvailableLobbies(friendsOnly);
    return this.formatResponse(result);
  }

  getLobbyUsers(lobbyId: Id<"lobbies">): string | LobbyUser[] {
    this.ensureReady();
    this.logger.debug(`Getting lobby users: ${lobbyId}`);
    const result = this.lobbyManager.getLobbyUsers(lobbyId);
    return this.formatResponse(result);
  }

  getNumLobbyUsers(lobbyId: Id<"lobbies">): number {
    this.ensureReady();
    this.logger.debug(`Getting number of lobby users: ${lobbyId}`);
    const result = this.lobbyManager.getNumLobbyUsers(lobbyId);
    return result;
  }

  getLobbyHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    this.ensureReady();
    return this.lobbyManager.getHostId(lobbyId);
  }

  getLobbyData(lobbyId: Id<"lobbies">, key: string): unknown {
    this.ensureReady();
    this.logger.debug(`Getting lobby data: ${key} for lobby: ${lobbyId}`);
    return this.lobbyManager.getLobbyData(lobbyId, key);
  }

  setLobbyData(lobbyId: Id<"lobbies">, key: string, value: unknown): boolean {
    this.ensureReady();
    this.logger.debug(`Setting lobby data: ${key} to ${value}`);
    return this.lobbyManager.setLobbyData(lobbyId, key, value);
  }

  async leaveLobby(
    lobbyId: Id<"lobbies">
  ): Promise<string | WavedashResponse<Id<"lobbies">>> {
    this.ensureReady();
    this.logger.debug(`Leaving lobby: ${lobbyId}`);
    const result = await this.lobbyManager.leaveLobby(lobbyId);
    return this.formatResponse(result);
  }

  // Fire and forget, returns true if the message was sent out successfully
  // Game can listen for the LobbyMessage signal to get the message that was posted
  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    this.ensureReady();
    return this.lobbyManager.sendLobbyMessage(lobbyId, message);
  }

  // ==============================
  // User Presence
  // ==============================
  /**
   * Updates rich user presence so friends can see what the player is doing in game
   * TODO: data param should be more strongly typed
   * @param data Game data to send to the backend
   * @returns true if the presence was updated successfully
   */
  async updateUserPresence(data?: Record<string, unknown>): Promise<boolean> {
    this.ensureReady();
    const result = await this.heartbeatManager.updateUserPresence(data);
    return result;
  }

  // ==============================
  // JS -> Game Event Broadcasting
  // ==============================
  notifyGame(
    signal: Signal,
    payload: string | number | boolean | object
  ): void {
    const data =
      typeof payload === "object" ? JSON.stringify(payload) : payload;
    this.engineInstance?.SendMessage(this.engineCallbackReceiver, signal, data);
  }

  // ================
  // Internal Helpers
  // ================

  private isGodot(): boolean {
    return (
      this.engineInstance !== null &&
      this.engineInstance.type === GAME_ENGINE.GODOT
    );
  }

  // Helper to format response based on context
  // Godot callbacks expect a string, so we need to format the response accordingly
  private formatResponse<T>(data: T): T | string {
    return this.isGodot() ? JSON.stringify(data) : data;
  }

  // Helper to ensure SDK is ready, throws if not
  private ensureReady(): void {
    if (!this.isReady()) {
      this.logger.warn("SDK not initialized. Call init() first.");
      throw new Error("SDK not initialized");
    }
  }

  // ============
  // Entrypoint Helpers
  // ============
  loadScript(src: string) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.src = src;
      script.crossOrigin = "use-credentials"; // Enable CORS with credentials (cookies, auth)
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  updateLoadProgressZeroToOne(progress: number) {
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.PROGRESS_UPDATE, {
      progress
    });
  }

  loadComplete() {
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOADING_COMPLETE, {});
    // Take focus when loading is complete
    takeFocus();
  }
}

// =======
// Exports
// =======

export { WavedashSDK };

// Re-export all types
export type * from "./types";

// Type-safe initialization helper
export async function setupWavedashSDK(): Promise<WavedashSDK> {
  console.log("[WavedashJS] Setting up SDK");
  const sdkConfig = await iframeMessenger.requestFromParent(
    IFRAME_MESSAGE_TYPE.GET_SDK_CONFIG
  );

  const sdk = new WavedashSDK(sdkConfig);

  (window as unknown as { WavedashJS: WavedashSDK }).WavedashJS = sdk;

  return sdk;
}
