import { ConvexClient } from "convex/browser";
import { LobbyManager } from "./services/lobby";
import { FileSystemManager } from "./services/fileSystem";
import { UGCManager } from "./services/ugc";
import { LeaderboardManager } from "./services/leaderboards";
import { P2PManager } from "./services/p2p";
import { StatsManager } from "./services/stats";
import { HeartbeatManager } from "./services/heartbeat";
import { GameEventManager } from "./services/gameEvents";
import {
  FriendsManager,
  AVATAR_SIZE_SMALL,
  AVATAR_SIZE_MEDIUM,
  AVATAR_SIZE_LARGE
} from "./services/friends";
import { WavedashLogger, LOG_LEVEL } from "./utils/logger";
import { IFrameMessenger } from "./utils/iframeMessenger";
import { takeFocus } from "./utils/focusManager";
import { WavedashEvents } from "./types";

type WavedashService = 
  | LobbyManager
  | FileSystemManager
  | UGCManager
  | LeaderboardManager
  | P2PManager
  | HeartbeatManager
  | FriendsManager
  | StatsManager;

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
  Lobby,
  Friend
} from "./types";
import {
  GAME_ENGINE,
  IFRAME_MESSAGE_TYPE,
  SDKConfig,
  SDKUser
} from "@wvdsh/types";
import { parentOrigin } from "./utils/parentOrigin";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

class WavedashSDK extends EventTarget {
  private initialized: boolean = false;
  private lobbyIdToJoinOnStartup?: Id<"lobbies">;
  private sessionEndSent: boolean = false;
  private convexHttpUrl: string;
  private gameFinishedLoading: boolean = false;

  Events = WavedashEvents;

  protected lobbyManager: LobbyManager;
  protected statsManager: StatsManager;
  protected heartbeatManager: HeartbeatManager;
  protected ugcManager: UGCManager;
  protected leaderboardManager: LeaderboardManager;
  gameEventManager: GameEventManager;
  friendsManager: FriendsManager;

  config: WavedashConfig | null = null;
  wavedashUser: SDKUser;
  gameCloudId: string;
  fileSystemManager: FileSystemManager;
  convexClient: ConvexClient;
  engineCallbackReceiver: string = "WavedashCallbackReceiver";
  engineInstance: EngineInstance | null = null;
  logger: WavedashLogger;
  iframeMessenger: IFrameMessenger;
  p2pManager: P2PManager;
  gameplayJwt: string | null = null;
  ugcHost: string;
  uploadsHost: string;

  constructor(sdkConfig: SDKConfig) {
    super();
    this.convexClient = new ConvexClient(sdkConfig.convexCloudUrl);
    this.gameCloudId = sdkConfig.gameCloudId; // needs to be above getAuthToken don't move this
    this.convexClient.setAuth(() => this.getAuthToken());
    this.convexHttpUrl = sdkConfig.convexHttpUrl;
    this.wavedashUser = sdkConfig.wavedashUser;

    this.ugcHost = sdkConfig.ugcHost;
    this.uploadsHost = sdkConfig.uploadsHost;
    this.logger = new WavedashLogger();
    this.p2pManager = new P2PManager(this);
    this.lobbyManager = new LobbyManager(this);
    this.statsManager = new StatsManager(this);
    this.heartbeatManager = new HeartbeatManager(
      this,
      sdkConfig.deviceFingerprint
    );
    this.fileSystemManager = new FileSystemManager(this);
    this.ugcManager = new UGCManager(this);
    this.leaderboardManager = new LeaderboardManager(this);
    this.friendsManager = new FriendsManager(this);
    this.gameEventManager = new GameEventManager(this);
    this.iframeMessenger = iframeMessenger;

    // Cache current user for avatar lookups
    this.friendsManager.cacheUsers([
      {
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username,
        avatarUrl: this.wavedashUser.avatarUrl
      }
    ]);

    this.setupSessionEndListeners();

    // TODO: Add event queueing system to handle events that happen before the game is ready for events
    // For now this is the only event we need to wait on, so just triggering it as soon as the game is ready
    this.lobbyIdToJoinOnStartup = sdkConfig.lobbyIdToJoin;
  }

  // =============
  // Setup methods
  // =============

  init(config: WavedashConfig): boolean {
    if (this.initialized) {
      this.logger.warn("init called twice! Already initialized, skipping init");
      return false;
    }
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

    // Initialize P2P manager with config (validates and allocates ring buffers)
    this.p2pManager.init(this.config.p2p);

    if (this.config.disableAchievementsAndStats) {
      this.statsManager.setDisabled(true);
    }

    this.logger.debug("Initialized with config:", this.config);
    // Initialize lobby manager
    this.lobbyManager.init();

    // Join a lobby on startup if provided (from invite link or external source)
    if (this.lobbyIdToJoinOnStartup && !this.config.deferEvents) {
      this.lobbyManager
        .joinLobby(this.lobbyIdToJoinOnStartup)
        .catch((error) => {
          this.logger.error("Could not join lobby on startup:", error);
        });
    }

    return true;
  }

  readyForEvents(): void {
    this.ensureReady();
    if (!this.config?.deferEvents) {
      return;
    }
    this.config!.deferEvents = false;

    // Flush any queued events now that the game is ready
    this.gameEventManager.flushEventQueue();

    // Game is now ready for event messages, join a lobby if provided (from invite link or external source)
    if (this.lobbyIdToJoinOnStartup) {
      this.lobbyManager
        .joinLobby(this.lobbyIdToJoinOnStartup)
        .catch((error) => {
          this.logger.error("Could not join lobby on startup:", error);
        });
    }
  }

  // ==================
  // Entrypoint Helpers
  // ==================
  loadScript(src: string) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.crossOrigin = "anonymous";
      script.src = src;
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
    this.gameFinishedLoading = true;
    this.heartbeatManager.start();
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOADING_COMPLETE, {});
    // Take focus when loading is complete
    takeFocus();
  }

  get gameLoaded(): boolean {
    return this.gameFinishedLoading;
  }

  toggleOverlay(): void {
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.TOGGLE_OVERLAY, {});
  }

  // ============
  // User methods
  // ============

  getUser(): SDKUser {
    return this.formatResponse(this.wavedashUser);
  }

  getUsername(): string {
    return this.wavedashUser.username;
  }

  getUserId(): Id<"users"> {
    return this.wavedashUser.id;
  }

  // ============
  // Friends
  // ============

  async listFriends(): Promise<WavedashResponse<Friend[]>> {
    return this.apiCall(this.friendsManager, "listFriends");
  }

  /**
   * Get avatar URL for a cached user with size transformation.
   * Users are cached when seen via listFriends() or lobby membership.
   * @param userId - The user ID to get the avatar URL for
   * @param size - Avatar size constant (AVATAR_SIZE_SMALL=0, AVATAR_SIZE_MEDIUM=1, AVATAR_SIZE_LARGE=2)
   * @returns CDN URL with size transformation, or null if user not cached or has no avatar
   */
  getUserAvatarUrl(
    userId: Id<"users">,
    size: number = AVATAR_SIZE_MEDIUM
  ): string | null {
    this.ensureReady();
    return this.friendsManager.getUserAvatarUrl(userId, size);
  }

  // ============
  // Leaderboards
  // ============

  async getLeaderboard(
    name: string
  ): Promise<WavedashResponse<Leaderboard>> {
    return this.apiCall(this.leaderboardManager, "getLeaderboard", name);
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<WavedashResponse<Leaderboard>> {
    return this.apiCall(
      this.leaderboardManager,
      "getOrCreateLeaderboard",
      name,
      sortOrder,
      displayType
    );
  }

  // Synchronously get leaderboard entry count from cache
  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    return this.apiCallSync(
      this.leaderboardManager,
      "getLeaderboardEntryCount",
      leaderboardId
    );
  }

  // This is called get my "entries" but under the hood we enforce one entry per user
  // The engine SDK expects a list of entries, so we return a list with 0 or 1 entries
  async getMyLeaderboardEntries(
    leaderboardId: Id<"leaderboards">
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    return this.apiCall(
      this.leaderboardManager,
      "getMyLeaderboardEntries",
      leaderboardId
    );
  }

  async listLeaderboardEntriesAroundUser(
    leaderboardId: Id<"leaderboards">,
    countAhead: number,
    countBehind: number,
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    return this.apiCall(
      this.leaderboardManager,
      "listLeaderboardEntriesAroundUser",
      leaderboardId,
      countAhead,
      countBehind,
      friendsOnly
    );
  }

  async listLeaderboardEntries(
    leaderboardId: Id<"leaderboards">,
    offset: number,
    limit: number,
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<LeaderboardEntries>> {
    return this.apiCall(
      this.leaderboardManager,
      "listLeaderboardEntries",
      leaderboardId,
      offset,
      limit,
      friendsOnly
    );
  }

  async uploadLeaderboardScore(
    leaderboardId: Id<"leaderboards">,
    score: number,
    keepBest: boolean,
    ugcId?: Id<"userGeneratedContent">
  ): Promise<WavedashResponse<UpsertedLeaderboardEntry>> {
    return this.apiCall(
      this.leaderboardManager,
      "uploadLeaderboardScore",
      leaderboardId,
      score,
      keepBest,
      ugcId
    );
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
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    return this.apiCall(
      this.ugcManager,
      "createUGCItem",
      ugcType,
      title,
      description,
      visibility,
      filePath
    );
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
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    return this.apiCall(
      this.ugcManager,
      "updateUGCItem",
      ugcId,
      title,
      description,
      visibility,
      filePath
    );
  }

  async downloadUGCItem(
    ugcId: Id<"userGeneratedContent">,
    filePath: string
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    return this.apiCall(this.ugcManager, "downloadUGCItem", ugcId, filePath);
  }

  // ================================
  // Save state / Remote File Storage
  // ================================

  /**
   * Deletes a remote file from storage
   * @param filePath - The path of the remote file to delete
   * @returns The path of the remote file that was deleted
   */
  async deleteRemoteFile(
    filePath: string
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(this.fileSystemManager, "deleteRemoteFile", filePath);
  }

  /**
   * Downloads a remote file to a local location
   * @param filePath - The path of the remote file to download
   * @param downloadTo - Optionally provide a path to download the file to, defaults to the same path as the remote file
   * @returns The path of the local file that the remote file was downloaded to
   */
  async downloadRemoteFile(
    filePath: string
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(this.fileSystemManager, "downloadRemoteFile", filePath);
  }

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @param uploadTo - Optionally provide a path to upload the file to, defaults to the same path as the local file
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(
    filePath: string
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(this.fileSystemManager, "uploadRemoteFile", filePath);
  }

  /**
   * Lists a remote directory
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(
    path: string
  ): Promise<WavedashResponse<RemoteFileMetadata[]>> {
    return this.apiCall(this.fileSystemManager, "listRemoteDirectory", path);
  }

  /**
   * Downloads a remote directory to a local location
   * @param path - The path of the remote directory to download
   * @returns The path of the local directory that the remote directory was downloaded to
   */
  async downloadRemoteDirectory(
    path: string
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(
      this.fileSystemManager,
      "downloadRemoteDirectory",
      path
    );
  }

  /**
   * Persists data to local file storage (IndexeDB).
   * For use in pure JS games.
   * Games built from engines should use their engine's builtin File API to read and write files.
   * @param filePath - The path of the local file to write
   * @param data - The data to write to the local file (byte array)
   * @returns true if the file was written successfully
   */
  async writeLocalFile(filePath: string, data: Uint8Array): Promise<boolean> {
    this.ensureReady();
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
  async readLocalFile(filePath: string): Promise<Uint8Array | null> {
    this.ensureReady();
    const result = await this.fileSystemManager.readLocalFile(filePath);
    return result;
  }

  // ============
  // Achievements + Stats
  // ============
  getAchievement(identifier: string): boolean {
    return this.apiCallSync(this.statsManager, "getAchievement", identifier);
  }
  getStat(identifier: string): number {
    return this.apiCallSync(this.statsManager, "getStat", identifier);
  }
  setAchievement(identifier: string): void {
    this.apiCallSync(this.statsManager, "setAchievement", identifier);
  }
  setStat(identifier: string, value: number): void {
    this.apiCallSync(this.statsManager, "setStat", identifier, value);
  }
  async requestStats(): Promise<WavedashResponse<boolean>> {
    return this.apiCall(this.statsManager, "requestStats");
  }
  storeStats(): boolean {
    return this.apiCallSync(this.statsManager, "storeStats");
  }

  // ============
  // P2P Networking
  // ============

  /**
   * Get the maximum payload size in bytes for a single P2P message.
   * This is derived from the configured messageSize minus protocol overhead.
   */
  getP2PMaxPayloadSize(): number {
    this.ensureReady();
    return this.p2pManager.getMaxPayloadSize();
  }

  /**
   * Get the configured max incoming messages per channel queue.
   */
  getP2PMaxIncomingMessages(): number {
    this.ensureReady();
    return this.p2pManager.getMaxIncomingMessages();
  }

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

  /**
   * Create a new lobby and join it as the host.
   * @param visibility - The visibility of the lobby
   * @param maxPlayers - Optional maximum number of players
   * @returns A WavedashResponse with the created lobbyId.
   *          Full lobby context is provided via the LobbyJoined event.
   * @emits LobbyJoined event on success with full lobby context
   */
  async createLobby(
    visibility: LobbyVisibility,
    maxPlayers?: number
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    return this.apiCall(
      this.lobbyManager,
      "createLobby",
      visibility,
      maxPlayers
    );
  }

  /**
   * Join an existing lobby.
   * @param lobbyId - The ID of the lobby to join
   * @returns A WavedashResponse with success/failure.
   *          Full lobby context is provided via the LobbyJoined event.
   * @emits LobbyJoined event on success with full lobby context
   */
  async joinLobby(
    lobbyId: Id<"lobbies">
  ): Promise<WavedashResponse<boolean>> {
    return this.apiCall(this.lobbyManager, "joinLobby", lobbyId);
  }

  async listAvailableLobbies(
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<Lobby[]>> {
    return this.apiCall(this.lobbyManager, "listAvailableLobbies", friendsOnly);
  }

  getLobbyUsers(lobbyId: Id<"lobbies">): LobbyUser[] {
    return this.apiCallSync(this.lobbyManager, "getLobbyUsers", lobbyId);
  }

  getNumLobbyUsers(lobbyId: Id<"lobbies">): number {
    return this.apiCallSync(this.lobbyManager, "getNumLobbyUsers", lobbyId);
  }

  getLobbyHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    this.ensureReady();
    return this.lobbyManager.getHostId(lobbyId);
  }

  getLobbyData(lobbyId: Id<"lobbies">, key: string): unknown {
    return this.apiCallSync(this.lobbyManager, "getLobbyData", lobbyId, key);
  }

  setLobbyData(lobbyId: Id<"lobbies">, key: string, value: unknown): boolean {
    this.ensureReady();
    this.logger.debug(`Setting lobby data: ${key} to ${value}`);
    return this.lobbyManager.setLobbyData(lobbyId, key, value);
  }

  async leaveLobby(
    lobbyId: Id<"lobbies">
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    return this.apiCall(this.lobbyManager, "leaveLobby", lobbyId);
  }

  // Fire and forget, returns true if the message was sent out successfully
  // Game can listen for the LobbyMessage event to get the message that was posted
  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    this.ensureReady();
    return this.lobbyManager.sendLobbyMessage(lobbyId, message);
  }

  async inviteUserToLobby(
    lobbyId: Id<"lobbies">,
    userId: Id<"users">
  ): Promise<WavedashResponse<boolean>> {
    return this.apiCall(
      this.lobbyManager,
      "inviteUserToLobby",
      lobbyId,
      userId
    );
  }

  async getLobbyInviteLink(
    copyToClipboard: boolean = false
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(
      this.lobbyManager,
      "getLobbyInviteLink",
      copyToClipboard
    );
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
    return this.heartbeatManager.updateUserPresence(data);
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

  // Godot expects JSON strings for complex data, but can accept primitives
  // Keep the typescript type as T so TS consumers don't have to deal with the | string type
  private formatResponse<T>(data: T): T {
    if (this.isGodot() && typeof data === "object" && data !== null) {
      return JSON.stringify(data) as unknown as T;
    }
    return data;
  }

  // Helper to ensure SDK is ready, throws if not
  private ensureReady(): void {
    if (!this.initialized) {
      this.logger.warn("SDK not initialized. Call init() first.");
      throw new Error("SDK not initialized");
    }
  }

  private async apiCall<
    T extends WavedashService,
    K extends string & keyof T
  >(
    manager: T,
    method: K,
    ...args: Parameters<Extract<T[K], AnyFn>>
  ): Promise<WavedashResponse<Awaited<ReturnType<Extract<T[K], AnyFn>>>>> {
    this.ensureReady();
    this.logger.debug(method, ...args);
    try {
      const data = await (manager[method] as AnyFn)(...args);
      return this.formatResponse({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(method, message);
      return this.formatResponse({ success: false, data: null, message });
    }
  }

  private apiCallSync<
    T extends WavedashService,
    K extends string & keyof T
  >(
    target: T,
    method: K,
    ...args: Parameters<Extract<T[K], AnyFn>>
  ): ReturnType<Extract<T[K], AnyFn>> {
    this.ensureReady();
    this.logger.debug(method, ...args);
    return this.formatResponse((target[method] as AnyFn)(...args));
  }

  /**
   * Set or update the engine instance (Unity or Godot).
   * This method is additive - it merges properties into any existing instance.
   * Can be called multiple times in any order (e.g., JSLib sets FS first, runner sets the unityInstance later).
   * This handles the race condition where a Unity game can actually start running BEFORE window.createUnityInstance resolves
   * @param engineInstance - The engine instance or partial attributes to merge.
   */
  private setEngineInstance(engineInstance: Partial<EngineInstance>): void {
    if (this.engineInstance) {
      Object.assign(this.engineInstance, engineInstance);
    } else {
      this.engineInstance = engineInstance as EngineInstance;
    }
  }

  private async getAuthToken(): Promise<string> {
    const response = await fetch(
      `${parentOrigin}/auth/gameplay_token?gcid=${this.gameCloudId}`,
      {
        credentials: "include"
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch gameplay token: ${response.status}`);
    }
    this.gameplayJwt = await response.text();
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

      this.lobbyManager.destroy();
      this.heartbeatManager.destroy();
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

  /**
   * @deprecated
   * Game generally shouldn't need to check this value
   * Can always just check WavedashJS.initialized if needed
   */
  private isReady(): boolean {
    return this.initialized;
  }
}

// =======
// Exports
// =======

export { WavedashSDK };

// Re-export avatar size constants
export { AVATAR_SIZE_SMALL, AVATAR_SIZE_MEDIUM, AVATAR_SIZE_LARGE };

// Re-export all types and constants
export * from "./types";

// Type-safe initialization helper
export async function setupWavedashSDK(): Promise<WavedashSDK> {
  const sdkConfig = await iframeMessenger.requestFromParent(
    IFRAME_MESSAGE_TYPE.GET_SDK_CONFIG
  );

  const sdk = new WavedashSDK(sdkConfig);

  (window as unknown as { WavedashJS: WavedashSDK }).WavedashJS = sdk;

  return sdk;
}
