import { ConvexClient } from "convex/browser";
import { LobbyManager } from "./services/lobby";
import { FileSystemManager } from "./services/fileSystem";
import { UGCManager } from "./services/ugc";
import { LeaderboardManager } from "./services/leaderboards";
import { P2PManager } from "./services/p2p";
import { StatsManager } from "./services/stats";
import { HeartbeatManager } from "./services/heartbeat";
import { GameEventManager } from "./services/gameEvents";
import { FullscreenManager } from "./services/fullscreen";
import { OverlayManager } from "./services/overlay";
import { AudioManager } from "./services/audio";
import { FriendsManager } from "./services/friends";
import { logger, LOG_LEVEL } from "./utils/logger";
import { IFrameMessenger } from "./utils/iframeMessenger";
import { SwMessenger } from "./utils/swMessenger";
import {
  LobbyKickedReason,
  LobbyUserChangeType,
  P2PPacketDropReason,
  AvatarSize,
  LOBBY_VISIBILITY,
  LEADERBOARD_SORT_ORDER,
  LEADERBOARD_DISPLAY_TYPE,
  UGC_TYPE,
  UGC_VISIBILITY,
  GAME_ENGINE
} from "./constants";
import { WavedashEvents } from "./events";
import type { WavedashEventMap } from "./types";
import type { WavedashManager } from "./services/manager";

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
  UpdateUGCItemArgs,
  PaginatedUGCItems,
  ListUGCItemsArgs,
  RemoteFileMetadata,
  P2PMessage,
  LobbyUser,
  Lobby,
  Friend,
  GameLaunchParams
} from "./types";
import { IFRAME_MESSAGE_TYPE, SDKConfig, SDKUser, UrlParams } from "@wvdsh/api";
import { setParentOrigin } from "./utils/parentOrigin";
import {
  type ArgSpec,
  validateArgs,
  vBoolean,
  vEnum,
  vId,
  vNull,
  vNumber,
  vOptional,
  vRecord,
  vString,
  vUint8Array,
  vUnion,
  vObject
} from "./utils/validation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => any;

class WavedashSDK extends EventTarget {
  private _initialized: boolean = false;
  get initialized(): boolean {
    return this._initialized;
  }
  private _eventsReady: boolean = false;
  get eventsReady(): boolean {
    return this._eventsReady;
  }
  private launchParams: GameLaunchParams;
  private destroyed: boolean = false;
  private gameFinishedLoading: boolean = false;

  // Expose constants for easy access `Wavedash.LobbyVisibility.PUBLIC` etc.
  Events = WavedashEvents;
  LobbyVisibility = LOBBY_VISIBILITY;
  LeaderboardSortOrder = LEADERBOARD_SORT_ORDER;
  LeaderboardDisplayType = LEADERBOARD_DISPLAY_TYPE;
  UGCType = UGC_TYPE;
  UGCVisibility = UGC_VISIBILITY;
  AvatarSize = AvatarSize;
  LobbyKickedReason = LobbyKickedReason;
  LobbyUserChangeType = LobbyUserChangeType;
  P2PPacketDropReason = P2PPacketDropReason;

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
  iframeMessenger: IFrameMessenger;
  swMessenger: SwMessenger;
  p2pManager: P2PManager;
  fullscreenManager: FullscreenManager;
  overlayManager: OverlayManager;
  audioManager: AudioManager;
  private managers: WavedashManager[];
  private gameplayJwt: string | null = null;
  private gameplayJwtPromise: Promise<string> | null = null;
  private setupWarningTimeout: ReturnType<typeof setTimeout> | null = null;
  ugcHost: string;
  uploadsHost: string;

  constructor(sdkConfig: SDKConfig) {
    super();
    this.convexClient = new ConvexClient(sdkConfig.convexCloudUrl, {
      expectAuth: true
    });
    this.gameCloudId = sdkConfig.gameCloudId; // needs to be above getAuthToken don't move this
    this.convexClient.setAuth(({ forceRefreshToken }) =>
      this.getAuthToken(forceRefreshToken)
    );
    this.wavedashUser = sdkConfig.wavedashUser;
    this.iframeMessenger = iframeMessenger;
    this.ugcHost = sdkConfig.ugcHost;
    this.uploadsHost = sdkConfig.uploadsHost;
    this.swMessenger = new SwMessenger();
    this.p2pManager = new P2PManager(this);
    this.lobbyManager = new LobbyManager(this);
    this.statsManager = new StatsManager(this);
    this.heartbeatManager = new HeartbeatManager(this);
    this.fileSystemManager = new FileSystemManager(this);
    this.ugcManager = new UGCManager(this);
    this.leaderboardManager = new LeaderboardManager(this);
    this.friendsManager = new FriendsManager(this);
    this.gameEventManager = new GameEventManager(this);
    this.fullscreenManager = new FullscreenManager(this);
    this.overlayManager = new OverlayManager(this);
    this.audioManager = new AudioManager(this);

    // Single source of truth for teardown — `destroy()` iterates this list.
    // Order matches construction so destroys happen in dependency order
    // (e.g. lobby's destroy may want p2p, but lobby is created after p2p).
    this.managers = [
      this.p2pManager,
      this.lobbyManager,
      this.statsManager,
      this.heartbeatManager,
      this.fileSystemManager,
      this.ugcManager,
      this.leaderboardManager,
      this.friendsManager,
      this.gameEventManager,
      this.fullscreenManager,
      this.overlayManager,
      this.audioManager
    ];

    // Cache current user for avatar lookups
    this.friendsManager.cacheUsers([
      {
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username,
        avatarUrl: this.wavedashUser.avatarUrl
      }
    ]);

    this.setupSessionEndListeners();
    this.setupSwCredsListener();

    this.launchParams = sdkConfig.launchParams ?? {};

    this.setupWarningTimeout = setTimeout(() => {
      this.setupWarningTimeout = null;
      logger.warn(
        "Wavedash.init(), Wavedash.loadComplete(), or Wavedash.updateLoadProgressZeroToOne() not called yet"
      );
    }, 10_000);
  }

  private clearSetupWarning(): void {
    if (this.setupWarningTimeout !== null) {
      clearTimeout(this.setupWarningTimeout);
      this.setupWarningTimeout = null;
    }
  }

  // =============
  // Setup methods
  // =============

  init(config?: WavedashConfig): boolean {
    this.loadComplete();
    if (this._initialized) {
      logger.warn("init called twice! Already initialized, skipping init");
      return false;
    }
    if (typeof config === "string") {
      try {
        config = JSON.parse(config);
      } catch (error) {
        logger.error("Initialized with invalid config:", error);
        return false;
      }
    }

    this.config = (config as WavedashConfig) ?? {};
    this._initialized = true;

    // Update logger debug mode based on config
    logger.setLogLevel(this.config.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.WARN);

    // Initialize P2P manager with config (validates and allocates ring buffers)
    this.p2pManager.init(this.config.p2p);

    logger.debug("Initialized with config:", this.config);

    if (!this.config.deferEvents) {
      this.readyForEvents();
    }

    return true;
  }

  /**
   * Signal that the game is ready to receive events (LobbyJoined, LobbyMessage, etc).
   * Called automatically by init() unless deferEvents: true is passed in the config.
   * If deferEvents is true, call this manually after your pre-game setup is complete.
   */
  readyForEvents(): void {
    if (this._eventsReady) return;
    this.ensureInit();
    this._eventsReady = true;
    this.gameEventManager.flushEventQueue();
  }

  // ==============
  // Event listening
  // ==============

  // Wrappers stored so `off(event, listener)` can find the wrapped EventListener
  // we registered on the EventTarget for a given user-supplied payload listener.
  private listenerWrappers = new Map<string, Map<AnyFn, EventListener>>();

  /**
   * Subscribe to a Wavedash event with a payload-typed listener.
   * Returns an unsubscribe function.
   *
   *   const unsubscribeLobbyJoined = Wavedash.on(Wavedash.Events.LOBBY_JOINED, (payload) => {
   *     // payload: LobbyJoinedPayload
   *   });
   *   unsubscribeLobbyJoined(); // later
   */
  on<K extends keyof WavedashEventMap>(
    event: K,
    listener: (payload: WavedashEventMap[K]) => void
  ): () => void {
    const wrapped: EventListener = (e) => {
      listener((e as CustomEvent<WavedashEventMap[K]>).detail);
    };
    let perEvent = this.listenerWrappers.get(event);
    if (!perEvent) {
      perEvent = new Map();
      this.listenerWrappers.set(event, perEvent);
    }
    // Match addEventListener semantics: same (event, listener) pair is a no-op
    // on second call. Detach the previous wrapper before re-registering.
    const prev = perEvent.get(listener);
    if (prev) this.removeEventListener(event, prev);
    perEvent.set(listener, wrapped);
    this.addEventListener(event, wrapped);
    return () => this.off(event, listener);
  }

  /**
   * Remove a listener previously registered with {@link on}.
   */
  off<K extends keyof WavedashEventMap>(
    event: K,
    listener: (payload: WavedashEventMap[K]) => void
  ): void {
    const perEvent = this.listenerWrappers.get(event);
    const wrapped = perEvent?.get(listener);
    if (!perEvent || !wrapped) return;
    this.removeEventListener(event, wrapped);
    perEvent.delete(listener);
    if (perEvent.size === 0) this.listenerWrappers.delete(event);
  }

  // Typed overloads for addEventListener / removeEventListener so callers using
  // a Wavedash event name get a CustomEvent<Payload>; arbitrary strings still
  // fall back to the loose EventTarget signature.
  addEventListener<K extends keyof WavedashEventMap>(
    type: K,
    listener: (ev: CustomEvent<WavedashEventMap[K]>) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: any,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof WavedashEventMap>(
    type: K,
    listener: (ev: CustomEvent<WavedashEventMap[K]>) => void,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: any,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, listener, options);
  }

  // ==================
  // Entrypoint Helpers
  // ==================
  loadScript(src: string) {
    validateArgs("loadScript", [["src", vString]], [src]);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "text/javascript";
      script.crossOrigin = "anonymous"; // Allow cross-origin CDN scripts if they have CORS headers
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  updateLoadProgressZeroToOne(progress: number) {
    validateArgs(
      "updateLoadProgressZeroToOne",
      [["progress", vNumber]],
      [progress]
    );
    this.clearSetupWarning();
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.PROGRESS_UPDATE, {
      progress
    });
  }

  loadComplete() {
    this.clearSetupWarning();
    if (this.gameFinishedLoading) return;
    this.gameFinishedLoading = true;
    this.heartbeatManager.start();
    iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOADING_COMPLETE, {});
    // Take focus when loading is complete
    this.overlayManager.takeFocus();
  }

  get gameLoaded(): boolean {
    return this.gameFinishedLoading;
  }

  toggleOverlay(): void {
    this.overlayManager.toggleOverlay();
  }

  // ==========
  // Fullscreen
  // ==========

  /**
   * Whether the game is currently presented in fullscreen. Mirrored from the
   * Wavedash host page, which owns the real fullscreen target so our overlay
   * UI stays on top of the game.
   */
  isFullscreen(): boolean {
    return this.fullscreenManager.isFullscreen();
  }

  /**
   * Ask the host page to enter (true) or exit (false) fullscreen. Entering
   * must happen inside a user gesture handler (click / keydown / pointerdown)
   * for the browser to permit it.
   */
  async requestFullscreen(fullscreen: boolean): Promise<boolean> {
    return this.fullscreenManager.requestFullscreen(fullscreen);
  }

  /**
   * Toggle fullscreen. Like `requestFullscreen(true)`, this must run inside
   * a user gesture handler when entering fullscreen.
   */
  async toggleFullscreen(): Promise<boolean> {
    return this.fullscreenManager.toggleFullscreen();
  }

  // ============
  // User methods
  // ============

  getUser(): SDKUser {
    return this.formatResponse(this.wavedashUser);
  }

  /**
   * Get a username. Returns the logged in user's username if no ID is passed.
   * This can only return a username for a user the game has already interacted with, either via listFriends() or shared lobby membership.
   * @param userId - Optional user ID to look up. If omitted, returns the current user's username.
   * @returns The username, or null if a userId was passed but the user has not been seen by the game yet.
   */
  getUsername(): string;
  getUsername(userId: Id<"users">): string | null;
  getUsername(userId?: Id<"users">): string | null {
    if (userId === undefined) {
      return this.wavedashUser.username;
    }
    validateArgs("getUsername", [["userId", vId("users")]], [userId]);
    return this.friendsManager.getUsername(userId);
  }

  getUserId(): Id<"users"> {
    return this.wavedashUser.id;
  }

  /**
   * Get the current user's gameplay JWT, fetching it if not already cached.
   * This should be used to authenticate requests to your game's own backend,
   * if you have one.
   * @returns The user's JWT signed by the Wavedash backend
   */
  async getUserJwt(): Promise<WavedashResponse<string>> {
    logger.debug("getUserJwt");
    try {
      const data = await this.ensureGameplayJwt();
      return this.formatResponse({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("getUserJwt", message);
      return this.formatResponse({ success: false, data: null, message });
    }
  }

  /**
   * Get the key: value mapping of all URL query params present when the game was launched
   * lobby - The lobby ID to join if the user launched with the intention to join a lobby
   * @returns Dictionary of the URL query params that were present when the game was launched
   */
  getLaunchParams(): GameLaunchParams {
    return this.formatResponse(this.launchParams);
  }

  // ============
  // Friends
  // ============

  async listFriends(): Promise<WavedashResponse<Friend[]>> {
    return this.apiCall(this.friendsManager, "listFriends", []);
  }

  /**
   * Get avatar URL for a cached user with size transformation.
   * Users are cached when seen via listFriends() or lobby membership.
   * @param userId - The user ID to get the avatar URL for
   * @param size - Avatar size constant (Wavedash.AvatarSize.SMALL=0, Wavedash.AvatarSize.MEDIUM=1, Wavedash.AvatarSize.LARGE=2)
   * @returns CDN URL with size transformation, or null if user not cached or has no avatar
   */
  getUserAvatarUrl(
    userId: Id<"users">,
    size: number = this.AvatarSize.MEDIUM
  ): string | null {
    return this.apiCallSync(
      this.friendsManager,
      "getUserAvatarUrl",
      [
        ["userId", vId("users")],
        ["size", vNumber]
      ],
      userId,
      size
    );
  }

  // ============
  // Leaderboards
  // ============

  async getLeaderboard(name: string): Promise<WavedashResponse<Leaderboard>> {
    return this.apiCall(
      this.leaderboardManager,
      "getLeaderboard",
      [["name", vString]],
      name
    );
  }

  async getOrCreateLeaderboard(
    name: string,
    sortOrder: LeaderboardSortOrder,
    displayType: LeaderboardDisplayType
  ): Promise<WavedashResponse<Leaderboard>> {
    return this.apiCall(
      this.leaderboardManager,
      "getOrCreateLeaderboard",
      [
        ["name", vString],
        ["sortOrder", vEnum(LEADERBOARD_SORT_ORDER, "LeaderboardSortOrder")],
        [
          "displayType",
          vEnum(LEADERBOARD_DISPLAY_TYPE, "LeaderboardDisplayType")
        ]
      ],
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
      [["leaderboardId", vId("leaderboards")]],
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
      [["leaderboardId", vId("leaderboards")]],
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
      [
        ["leaderboardId", vId("leaderboards")],
        ["countAhead", vNumber],
        ["countBehind", vNumber],
        ["friendsOnly", vBoolean]
      ],
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
      [
        ["leaderboardId", vId("leaderboards")],
        ["offset", vNumber],
        ["limit", vNumber],
        ["friendsOnly", vBoolean]
      ],
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
      [
        ["leaderboardId", vId("leaderboards")],
        ["score", vNumber],
        ["keepBest", vBoolean],
        ["ugcId", vOptional(vId("userGeneratedContent"))]
      ],
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
      [
        ["ugcType", vEnum(UGC_TYPE, "UGCType")],
        ["title", vOptional(vString)],
        ["description", vOptional(vString)],
        ["visibility", vOptional(vEnum(UGC_VISIBILITY, "UGCVisibility"))],
        ["filePath", vOptional(vString)]
      ],
      ugcType,
      title,
      description,
      visibility,
      filePath
    );
  }

  /**
   * Updates a UGC item and uploads the file to the server if a filePath is provided
   * @param ugcId - The ID of the UGC item to update
   * @param updates - Object containing the fields to update. May also be passed
   *   as a JSON string by engine bridges (Godot) that can't marshal a dict.
   * @returns ugcId
   */
  async updateUGCItem(
    ugcId: Id<"userGeneratedContent">,
    updates: UpdateUGCItemArgs = {}
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    if (typeof updates === "string") {
      const raw = updates;
      try {
        updates = JSON.parse(raw);
      } catch (error) {
        const message = `updateUGCItem: invalid JSON: ${raw}`;
        logger.error(message, error);
        return this.formatResponse({
          success: false,
          data: null,
          message
        });
      }
    }
    return this.apiCall(
      this.ugcManager,
      "updateUGCItem",
      [
        ["ugcId", vId("userGeneratedContent")],
        [
          "updates",
          vOptional(
            vObject({
              title: vOptional(vString),
              description: vOptional(vString),
              visibility: vOptional(vEnum(UGC_VISIBILITY, "UGCVisibility")),
              filePath: vOptional(vString)
            })
          )
        ]
      ],
      ugcId,
      updates
    );
  }

  /**
   * Delete a UGC item: removes the row, the R2 object, and frees up the
   * user's storage quota by the size of the deleted upload.
   */
  async deleteUGCItem(
    ugcId: Id<"userGeneratedContent">
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    return this.apiCall(
      this.ugcManager,
      "deleteUGCItem",
      [["ugcId", vId("userGeneratedContent")]],
      ugcId
    );
  }

  async downloadUGCItem(
    ugcId: Id<"userGeneratedContent">,
    filePath: string
  ): Promise<WavedashResponse<Id<"userGeneratedContent">>> {
    return this.apiCall(
      this.ugcManager,
      "downloadUGCItem",
      [
        ["ugcId", vId("userGeneratedContent")],
        ["filePath", vString]
      ],
      ugcId,
      filePath
    );
  }

  async listUGCItems(
    args: ListUGCItemsArgs = {}
  ): Promise<WavedashResponse<PaginatedUGCItems>> {
    if (typeof args === "string") {
      const raw = args;
      try {
        args = JSON.parse(raw);
      } catch (error) {
        const message = `listUGCItems: invalid JSON: ${raw}`;
        logger.error(message, error);
        return this.formatResponse({
          success: false,
          data: null,
          message
        });
      }
    }
    return this.apiCall(
      this.ugcManager,
      "listUGCItems",
      [
        [
          "args",
          vOptional((value, path) => {
            const obj = vObject({
              createdBy: vOptional(vId("users")),
              ugcType: vOptional(vEnum(UGC_TYPE, "UGCType")),
              titleSearch: vOptional(vString),
              numItems: vOptional(vNumber),
              continueCursor: vOptional(vString)
            })(value, path);
            if (
              obj.continueCursor !== undefined &&
              (obj.createdBy !== undefined ||
                obj.ugcType !== undefined ||
                obj.titleSearch !== undefined ||
                obj.numItems !== undefined)
            ) {
              throw new Error(
                `${path}: continueCursor should be the only argument if present`
              );
            }
            return obj;
          })
        ]
      ],
      args
    );
  }

  // ================================
  // Save state / Remote File Storage
  // ================================

  /**
   * Deletes a remote file from storage
   * @param filePath - The path of the remote file to delete
   * @returns The path of the remote file that was deleted
   */
  async deleteRemoteFile(filePath: string): Promise<WavedashResponse<string>> {
    return this.apiCall(
      this.fileSystemManager,
      "deleteRemoteFile",
      [["filePath", vString]],
      filePath
    );
  }

  /**
   * Downloads a remote file to a local location.
   * Returns success=false (with the server status in `message`) if the file
   * doesn't exist or any other error occurs. See also: {@link remoteFileExists}
   * @param filePath - The path of the remote file to download
   * @returns The path of the local file that the remote file was downloaded to
   */
  async downloadRemoteFile(
    filePath: string
  ): Promise<WavedashResponse<string>> {
    return this.apiCall(
      this.fileSystemManager,
      "downloadRemoteFile",
      [["filePath", vString]],
      filePath
    );
  }

  /**
   * Checks whether a remote file exists. Sends a lightweight HEAD request to check for existence.
   * @param filePath - The path of the remote file to check
   * @returns true if the remote file exists, false if it does not.
   */
  async remoteFileExists(filePath: string): Promise<WavedashResponse<boolean>> {
    return this.apiCall(
      this.fileSystemManager,
      "remoteFileExists",
      [["filePath", vString]],
      filePath
    );
  }

  /**
   * Uploads a local file to remote storage
   * @param filePath - The path of the local file to upload
   * @param uploadTo - Optionally provide a path to upload the file to, defaults to the same path as the local file
   * @returns The path of the remote file that the local file was uploaded to
   */
  async uploadRemoteFile(filePath: string): Promise<WavedashResponse<string>> {
    return this.apiCall(
      this.fileSystemManager,
      "uploadRemoteFile",
      [["filePath", vString]],
      filePath
    );
  }

  /**
   * Lists a remote directory
   * @param path - The path of the remote directory to list
   * @returns A list of metadata for each file in the remote directory
   */
  async listRemoteDirectory(
    path: string
  ): Promise<WavedashResponse<RemoteFileMetadata[]>> {
    return this.apiCall(
      this.fileSystemManager,
      "listRemoteDirectory",
      [["path", vString]],
      path
    );
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
      [["path", vString]],
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
    validateArgs(
      "writeLocalFile",
      [
        ["filePath", vString],
        ["data", vUint8Array]
      ],
      [filePath, data]
    );
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
    validateArgs("readLocalFile", [["filePath", vString]], [filePath]);
    const result = await this.fileSystemManager.readLocalFile(filePath);
    return result;
  }

  // ============
  // Achievements + Stats
  // ============
  getAchievement(identifier: string): boolean {
    return this.apiCallSync(
      this.statsManager,
      "getAchievement",
      [["identifier", vString]],
      identifier
    );
  }
  getStat(identifier: string): number {
    return this.apiCallSync(
      this.statsManager,
      "getStat",
      [["identifier", vString]],
      identifier
    );
  }
  setAchievement(identifier: string, storeNow: boolean = false): boolean {
    return this.apiCallSync(
      this.statsManager,
      "setAchievement",
      [
        ["identifier", vString],
        ["storeNow", vBoolean]
      ],
      identifier,
      storeNow
    );
  }
  setStat(
    identifier: string,
    value: number,
    storeNow: boolean = false
  ): boolean {
    return this.apiCallSync(
      this.statsManager,
      "setStat",
      [
        ["identifier", vString],
        ["value", vNumber],
        ["storeNow", vBoolean]
      ],
      identifier,
      value,
      storeNow
    );
  }
  async requestStats(): Promise<WavedashResponse<boolean>> {
    return this.apiCall(this.statsManager, "requestStats", []);
  }
  storeStats(): boolean {
    return this.apiCallSync(this.statsManager, "storeStats", []);
  }

  // ============
  // P2P Networking
  // ============

  /**
   * Get the maximum payload size in bytes for a single P2P message.
   * This is derived from the configured messageSize minus protocol overhead.
   */
  getP2PMaxPayloadSize(): number {
    this.ensureInit();
    return this.apiCallSync(this.p2pManager, "getMaxPayloadSize", []);
  }

  /**
   * Get the configured max incoming messages per channel queue.
   */
  getP2PMaxIncomingMessages(): number {
    this.ensureInit();
    return this.apiCallSync(this.p2pManager, "getMaxIncomingMessages", []);
  }

  /**
   * Get a pre-allocated scratch buffer for outgoing messages
   * @returns A Uint8Array buffer that can your game can write the binary payload to before calling sendP2PMessage
   */
  getP2POutgoingMessageBuffer(): Uint8Array {
    this.ensureInit();
    return this.apiCallSync(this.p2pManager, "getOutgoingMessageBuffer", []);
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
    // HOT PATH: direct call to avoid apiCallSync overhead (logger, formatResponse)
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
    // HOT PATH: direct call to avoid apiCallSync overhead (logger, formatResponse)
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
   * Read one decoded P2P message from a specific channel.
   * Engine builds (Unity/Godot) should use drainP2PChannelToBuffer for the
   * hot path — it's batched and returns raw bytes without decode overhead.
   * @param appChannel - The channel to read from
   * @returns Decoded P2PMessage, or null if the channel has no pending messages.
   */
  readP2PMessageFromChannel(appChannel: number): P2PMessage | null {
    // HOT PATH: direct call to avoid apiCallSync overhead (logger, formatResponse)
    return this.p2pManager.readMessageFromChannel(appChannel);
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
    // HOT PATH: direct call to avoid apiCallSync overhead (logger, formatResponse)
    return this.p2pManager.drainChannelToBuffer(appChannel, buffer);
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
      [
        ["visibility", vEnum(LOBBY_VISIBILITY, "LobbyVisibility")],
        ["maxPlayers", vOptional(vNumber)]
      ],
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
  async joinLobby(lobbyId: Id<"lobbies">): Promise<WavedashResponse<boolean>> {
    return this.apiCall(
      this.lobbyManager,
      "joinLobby",
      [["lobbyId", vId("lobbies")]],
      lobbyId
    );
  }

  async listAvailableLobbies(
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<Lobby[]>> {
    return this.apiCall(
      this.lobbyManager,
      "listAvailableLobbies",
      [["friendsOnly", vBoolean]],
      friendsOnly
    );
  }

  getLobbyUsers(lobbyId: Id<"lobbies">): LobbyUser[] {
    return this.apiCallSync(
      this.lobbyManager,
      "getLobbyUsers",
      [["lobbyId", vId("lobbies")]],
      lobbyId
    );
  }

  getNumLobbyUsers(lobbyId: Id<"lobbies">): number {
    return this.apiCallSync(
      this.lobbyManager,
      "getNumLobbyUsers",
      [["lobbyId", vId("lobbies")]],
      lobbyId
    );
  }

  getLobbyHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    return this.apiCallSync(
      this.lobbyManager,
      "getHostId",
      [["lobbyId", vId("lobbies")]],
      lobbyId
    );
  }

  getLobbyData(lobbyId: Id<"lobbies">, key: string): string | number | null {
    return this.apiCallSync(
      this.lobbyManager,
      "getLobbyData",
      [
        ["lobbyId", vId("lobbies")],
        ["key", vString]
      ],
      lobbyId,
      key
    );
  }

  setLobbyData(
    lobbyId: Id<"lobbies">,
    key: string,
    value: string | number | null
  ): boolean {
    return this.apiCallSync(
      this.lobbyManager,
      "setLobbyData",
      [
        ["lobbyId", vId("lobbies")],
        ["key", vString],
        ["value", vUnion<string | number | null>(vString, vNumber, vNull)]
      ],
      lobbyId,
      key,
      value
    );
  }

  deleteLobbyData(lobbyId: Id<"lobbies">, key: string): boolean {
    return this.apiCallSync(
      this.lobbyManager,
      "deleteLobbyData",
      [
        ["lobbyId", vId("lobbies")],
        ["key", vString]
      ],
      lobbyId,
      key
    );
  }

  async leaveLobby(
    lobbyId: Id<"lobbies">
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    return this.apiCall(
      this.lobbyManager,
      "leaveLobby",
      [["lobbyId", vId("lobbies")]],
      lobbyId
    );
  }

  // Fire and forget, returns true if the message was sent out successfully
  // Game can listen for the LobbyMessage event to get the message that was posted
  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    return this.apiCallSync(
      this.lobbyManager,
      "sendLobbyMessage",
      [
        ["lobbyId", vId("lobbies")],
        ["message", vString]
      ],
      lobbyId,
      message
    );
  }

  async inviteUserToLobby(
    lobbyId: Id<"lobbies">,
    userId: Id<"users">
  ): Promise<WavedashResponse<boolean>> {
    return this.apiCall(
      this.lobbyManager,
      "inviteUserToLobby",
      [
        ["lobbyId", vId("lobbies")],
        ["userId", vId("users")]
      ],
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
      [["copyToClipboard", vBoolean]],
      copyToClipboard
    );
  }

  // ==============================
  // User Presence
  // ==============================
  /**
   * Updates rich user presence so friends can see what the player is doing in game.
   * Supported keys:
   *   `status`  — one-line activity shown as the primary line (e.g. "Traveling in a group")
   *   `details` — secondary context shown beneath the status (e.g. current zone or mode)
   * 
   * Pass an empty dictionary to clear all presence fields.
   * @param data Presence fields to update.
   * @returns true if the presence was updated successfully
   */
  async updateUserPresence(
    data: Record<string, string | number | boolean | null>
  ): Promise<WavedashResponse<boolean>> {
    if (typeof data === "string") {
      const raw = data as string;
      try {
        data = JSON.parse(raw);
      } catch (error) {
        const message = `updateUserPresence: invalid JSON: ${raw}`;
        logger.error(message, error);
        return this.formatResponse({
          success: false,
          data: null,
          message
        });
      }
    }
    return this.apiCall(
      this.heartbeatManager,
      "updateUserPresence",
      [["data", vRecord]],
      data
    );
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

  // Godot receives JSON strings for plain objects/arrays; typed as T for JS consumers
  private formatResponse<T>(data: T): T {
    if (
      this.isGodot() &&
      data !== null &&
      (Array.isArray(data) || Object.getPrototypeOf(data) === Object.prototype)
    ) {
      // Stringify objects and arrays for Godot compatibility
      // Do NOT stringify Uint8Arrays, Godot can receive them as JS buffers
      // Safe to cast as T, Godot never sees this type
      return JSON.stringify(data) as unknown as T;
    }
    // Otherwise, return the data as is
    return data;
  }

  // Throws if init() hasn't been called. Only used by methods that
  // require config or produce events (lobby join/create, P2P).
  private ensureInit(): void {
    if (!this._initialized) {
      logger.error("SDK not initialized. Call WavedashJS.init first.");
      throw new Error("SDK not initialized");
    }
  }

  private async apiCall<T extends WavedashManager, K extends string & keyof T>(
    manager: T,
    method: K,
    argSpecs: readonly ArgSpec[],
    ...args: Parameters<Extract<T[K], AnyFn>>
  ): Promise<WavedashResponse<Awaited<ReturnType<Extract<T[K], AnyFn>>>>> {
    logger.debug(method, ...args);
    try {
      validateArgs(method, argSpecs, args);
      const data = await (manager[method] as AnyFn)(...args);
      return this.formatResponse({ success: true, data });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(method, message);
      return this.formatResponse({ success: false, data: null, message });
    }
  }

  private apiCallSync<T extends WavedashManager, K extends string & keyof T>(
    target: T,
    method: K,
    argSpecs: readonly ArgSpec[],
    ...args: Parameters<Extract<T[K], AnyFn>>
  ): ReturnType<Extract<T[K], AnyFn>> {
    logger.debug(method, ...args);
    // Validation errors rethrow — sync callsites don't have a WavedashResponse
    // envelope to surface them through. The logger.error makes the cause
    // obvious in the browser console before the throw propagates.
    try {
      validateArgs(method, argSpecs, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(method, message);
      throw error;
    }
    return this.formatResponse((target[method] as AnyFn)(...args));
  }

  /**
   * Set or update the engine instance (Unity or Godot).
   * This method is additive - it merges properties into any existing instance.
   * Can be called multiple times in any order (e.g., JSLib sets FS first, runner sets the unityInstance later).
   * @param engineInstance - The engine instance or partial attributes to merge.
   * @internal
   */
  private setEngineInstance(engineInstance: Partial<EngineInstance>): void {
    if (this.engineInstance) {
      Object.assign(this.engineInstance, engineInstance);
    } else {
      this.engineInstance = engineInstance as EngineInstance;
    }
  }

  /**
   * Fetches (or returns cached) gameplay JWT. Callers outside of Convex's
   * setAuth should use {@link ensureGameplayJwt} instead; this method is the
   * fetcher wired into `ConvexClient.setAuth` and honors `forceRefresh` so the
   * server can invalidate a stale token.
   *
   * Same-origin POST to /auth/refresh on the play domain — the
   * gameplaySession cookie set by the play server during playKey exchange
   * authenticates the request, so no cross-origin credentials handling needed.
   *
   * Concurrent callers share a single in-flight fetch to avoid duplicate
   * refresh round-trips.
   */
  private getAuthToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.gameplayJwt) {
      return Promise.resolve(this.gameplayJwt);
    }
    if (!forceRefresh && this.gameplayJwtPromise) {
      return this.gameplayJwtPromise;
    }

    const promise = (async () => {
      const response = await fetch("/auth/refresh", {
        method: "POST",
        credentials: "same-origin"
      });
      if (!response.ok) {
        throw new Error(`Failed to refresh gameplay token: ${response.status}`);
      }
      this.gameplayJwt = await response.text();
      // Push to parent so it can handle /end-session on its own
      iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.GAMEPLAY_JWT_READY, {
        gameplayJwt: this.gameplayJwt
      });
      // Push to service worker so it can attach Bearer token
      this.swMessenger.postToServiceWorker({
        type: "embed.jwt-update",
        payload: { gameplayJwt: this.gameplayJwt }
      });
      return this.gameplayJwt;
    })().finally(() => {
      if (this.gameplayJwtPromise === promise) {
        this.gameplayJwtPromise = null;
      }
    });

    this.gameplayJwtPromise = promise;
    return promise;
  }

  /**
   * Returns the cached gameplay JWT, awaiting the in-flight fetch if one is
   * already running (e.g. from Convex's initial setAuth). Use this anywhere
   * you need to authenticate a request outside of the Convex client.
   */
  async ensureGameplayJwt(): Promise<string> {
    return this.getAuthToken();
  }

  /**
   * Tear down every manager. Called on the parent's `END_SESSION` signal
   */
  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const manager of this.managers) {
      manager.destroy();
    }
  }

  private setupSessionEndListeners(): void {
    iframeMessenger.addEventListener(IFRAME_MESSAGE_TYPE.END_SESSION, () =>
      this.destroy()
    );
  }

  /**
   * Respond to the service worker's `embed.creds-request` with the SDK's
   * current gameplay JWT. The SW asks when it wakes from termination with no
   * in-memory or IDB credentials (e.g. Safari ITP storage decay) — we're the
   * fastest live source. JWT only; sessionToken is owned by the SW + cookies.
   */
  private setupSwCredsListener(): void {
    this.swMessenger.addEventListener(
      "embed.creds-request",
      async (_payload, reply) => {
        let jwt: string;
        try {
          jwt = await this.ensureGameplayJwt();
        } catch (err) {
          logger.warn("Failed to resolve JWT for creds-request", err);
          return;
        }
        reply({
          type: "embed.creds-response",
          payload: { gameplayJwt: jwt }
        });
      }
    );
  }
}

// =======
// Exports
// =======

declare global {
  interface Window {
    Wavedash: WavedashSDK;
  }
}

export * from "./types";
export type { WavedashSDK };

// Type-safe initialization helper (idempotent — safe to call more than once).
export function setupWavedashSDK(): WavedashSDK {
  const existing = window.Wavedash;
  if (existing) return existing;

  const raw = new URLSearchParams(window.location.search).get(
    UrlParams.SdkConfig
  );
  if (!raw) {
    throw new Error(
      `Wavedash SDK: missing ?${UrlParams.SdkConfig}= query param on the iframe URL.`
    );
  }

  let sdkConfig: SDKConfig;
  try {
    sdkConfig = JSON.parse(raw) as SDKConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Wavedash SDK: failed to parse ?${UrlParams.SdkConfig}= as JSON: ${message}`
    );
  }

  // set before constructing the SDK so any postMessage handlers wired in the constructor
  // see the right value.
  setParentOrigin(sdkConfig.parentOrigin);

  const sdk = new WavedashSDK(sdkConfig);
  window.Wavedash = sdk;

  // Kept for backwards compatibility
  (window as unknown as { WavedashJS: WavedashSDK }).WavedashJS = sdk;

  return sdk;
}
