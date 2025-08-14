import { ConvexClient } from "convex/browser";
import { api } from "./convex_api";
import * as Constants from "./constants";
import type {
  Id,
  LobbyType,
  LeaderboardSortMethod,
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
  private config: WavedashConfig | null = null;
  private engineInstance: EngineInstance | null = null;
  private engineCallbackReceiver: string = "WavedashCallbackReceiver";
  private wavedashUser: WavedashUser;
  private convexClient: ConvexClient;
  private lobbyMessagesUnsubscribeFn: (() => void) | null = null;

  private leaderboardCache: Map<Id<"leaderboards">, Leaderboard> = new Map();

  Constants = Constants;
  
  constructor(convexClient: ConvexClient, wavedashUser: WavedashUser) {
    this.convexClient = convexClient;
    this.wavedashUser = wavedashUser;
  }

  // Helper to determine if we're in a game engine context
  private isGameEngine(): boolean {
    return this.engineInstance !== null;
  }

  // Helper to format response based on context
  // Game engines expect a string, so we need to format the response accordingly
  private formatResponse<T>(data: T): T | string {
    return this.isGameEngine() ? JSON.stringify(data) : data;
  }

  // Helper to update the leaderboard cache with the latest totalEntries value
  private updateLeaderboardCache(leaderboardId: Id<"leaderboards">, totalEntries: number): void {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    if (cachedLeaderboard && typeof totalEntries === "number") {
      this.leaderboardCache.set(leaderboardId, { ...cachedLeaderboard, totalEntries });
    }
  }

  private async getRecordFromIndexedDB(dbName: string, storeName: string, key: string): Promise<Record<string, any> | null> {
    return new Promise((resolve, reject) => {
      const openReq = indexedDB.open(dbName);
      openReq.onerror = () => reject(openReq.error);
      openReq.onupgradeneeded = () => reject(new Error("Unexpected DB upgrade; wrong DB/schema"));
      openReq.onsuccess = () => {
        const db = openReq.result;
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const getReq = store.get(key);
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => reject(getReq.error);
        tx.oncomplete = () => db.close();
      };
    });
  }

  private toBlobFromIndexedDBValue(value: any): Blob {
    if (value == null) throw new Error("File not found in IndexedDB");
    // Common IDBFS shapes:
    // - { contents: ArrayBuffer } or { contents: Uint8Array }
    // - Blob
    // - ArrayBuffer / Uint8Array
    if (value.contents != null) {
      const buf = value.contents instanceof Uint8Array ? value.contents : new Uint8Array(value.contents);
      return new Blob([buf], { type: "application/octet-stream" });
    }
    if (value instanceof Blob) return value;
    if (value instanceof Uint8Array) return new Blob([value], { type: "application/octet-stream" });
    if (value instanceof ArrayBuffer) return new Blob([value], { type: "application/octet-stream" });
    // Fallback for shapes like { data: ArrayBuffer } or { blob: Blob }
    if (value.data instanceof ArrayBuffer) return new Blob([value.data], { type: "application/octet-stream" });
    if (value.blob instanceof Blob) return value.blob;
    throw new Error("Unrecognized value shape from IndexedDB");
  }

  private async uploadFromIndexedDb(uploadUrl: string, indexedDBKey: string): Promise<boolean> {
    // TODO: The DB name '/userfs' and Object Store name 'FILE_DATA' might be Godot specific
    // see where Unity saves files to IndexedDB
    const record = await this.getRecordFromIndexedDB('/userfs', 'FILE_DATA', indexedDBKey);
    if (!record){
      throw new Error(`File not found in IndexedDB: ${indexedDBKey}`);
    }
    const blob = this.toBlobFromIndexedDBValue(record);
    const response = await fetch(uploadUrl, {
      method: 'POST',
      body: blob
    });
    return response.ok;
  }

  // ====================
  // Game -> JS functions
  // ====================

  init(config: WavedashConfig): boolean {
    if (!config) {
      console.error('[WavedashJS] Initialized with empty config');
      return false;
    }
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      }
      catch (error) {
        console.error('[WavedashJS] Initialized with invalid config:', error);
        return false;
      }
    }
  
    this.config = config;
    this.initialized = true;
    
    if (this.config.debug) {
      console.log('[WavedashJS] Initialized with config:', this.config);
    }
    return true;
  }

  setEngineInstance(engineInstance: EngineInstance): void {
    // In the Unity case, our custom HTML page sets this once the unity instance is ready.
    // In the Godot case, the Godot plugin sets this value itself.
    this.engineInstance = engineInstance;
  }

  getUser(): string | WavedashUser | null {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      return null;
    }

    return this.formatResponse(this.wavedashUser);
  }

  isReady(): boolean {
    return this.initialized;
  }

  async getLeaderboard(name: string): Promise<string | WavedashResponse<Leaderboard>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    if(this.config?.debug) {
      console.log(`[WavedashJS] Getting leaderboard: ${name}`);
    }

    const args = { name }

    try {
      const leaderboard = await this.convexClient.query(
        api.leaderboards.getLeaderboard,
        args
      );
      this.leaderboardCache.set(leaderboard.id, leaderboard);
      return this.formatResponse({
        success: true,
        data: leaderboard,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error getting leaderboard: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async getOrCreateLeaderboard(leaderboardName: string, sortMethod: LeaderboardSortMethod, displayType: LeaderboardDisplayType): Promise<string | WavedashResponse<Leaderboard>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    if(this.config?.debug) {
      console.log('[WavedashJS] Getting or creating leaderboard:', leaderboardName);
    }

    const args = {
      name: leaderboardName,
      sortOrder: sortMethod,
      displayType: displayType
    };

    try {
      const leaderboard = await this.convexClient.mutation(
        api.leaderboards.getOrCreateLeaderboard,
        args
      );
      this.leaderboardCache.set(leaderboard.id, leaderboard);
      return this.formatResponse({
        success: true,
        data: leaderboard,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error getting or creating leaderboard: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // This is called get my "entries" but under the hood we enforce one entry per user
  // The engine SDK expects a list of entries, so we return a list with 0 or 1 entries
  async getMyLeaderboardEntries(leaderboardId: Id<"leaderboards">): Promise<string | WavedashResponse<LeaderboardEntries>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    if(this.config?.debug) {
      console.log(`[WavedashJS] Getting logged in user's leaderboard entry for leaderboard: ${leaderboardId}`);
    }

    const args = { leaderboardId }

    try {
      const result = await this.convexClient.query(
        api.leaderboards.getMyLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateLeaderboardCache(leaderboardId, totalEntries);
      }
      const entry = result.entry ? {
        ...result.entry,
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username
      } : null;

      // TODO: Kind of weird to return a list when it will only ever have 0 or 1 entries
      // But this allows all get entries functions to share the same return type which the game SDK expects
      const entries = entry ? [entry] : [];

      return this.formatResponse({
        success: true,
        data: entries,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error getting my leaderboard entry: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // Synchronously get leaderboard entry count from cache
  getLeaderboardEntryCount(leaderboardId: Id<"leaderboards">): number {
    const cachedLeaderboard = this.leaderboardCache.get(leaderboardId);
    return cachedLeaderboard ? cachedLeaderboard.totalEntries : -1;
  }

  async listLeaderboardEntriesAroundUser(leaderboardId: Id<"leaderboards">, countAhead: number, countBehind: number): Promise<string | WavedashResponse<LeaderboardEntries>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    if(this.config?.debug) {
      console.log(`[WavedashJS] Listing entries around user for leaderboard: ${leaderboardId}`);
    }

    const args = { leaderboardId, countAhead, countBehind }

    try {
      const result = await this.convexClient.query(
        api.leaderboards.listEntriesAroundUser,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateLeaderboardCache(leaderboardId, totalEntries);
      }
      return this.formatResponse({
        success: true,
        data: result.entries,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error listing entries around user: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async listLeaderboardEntries(leaderboardId: Id<"leaderboards">, offset: number, limit: number): Promise<string | WavedashResponse<LeaderboardEntries>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    if(this.config?.debug) {
      console.log(`[WavedashJS] Listing entries for leaderboard: ${leaderboardId}`);
    }

    const args = { leaderboardId, offset, limit }

    try {
      const result = await this.convexClient.query(
        api.leaderboards.listEntries,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateLeaderboardCache(leaderboardId, totalEntries);
      }
      return this.formatResponse({
        success: true,
        data: result.entries,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error listing entries: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async uploadLeaderboardScore(leaderboardId: Id<"leaderboards">, score: number, keepBest: boolean, ugcId?: Id<"userGeneratedContent">): Promise<string | WavedashResponse<UpsertedLeaderboardEntry>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    if(this.config?.debug) {
      console.log(`[WavedashJS] Uploading score ${score} to leaderboard: ${leaderboardId}`);
    }

    const args = { leaderboardId, score, keepBest, ugcId }
    
    try {
      const result = await this.convexClient.mutation(
        api.leaderboards.upsertLeaderboardEntry,
        args
      );
      if (result && result.totalEntries) {
        const totalEntries = result.totalEntries;
        this.updateLeaderboardCache(leaderboardId, totalEntries);
      }
      const entry = {
        ...result.entry,
        userId: this.wavedashUser.id,
        username: this.wavedashUser.username
      }

      return this.formatResponse({
        success: true,
        data: entry,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error upserting leaderboard entry: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // USER GENERATED CONTENT
  
  async createUGCItem(ugcType: UGCType, title?: string, description?: string, visibility?: UGCVisibility): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    const args = { ugcType, title, description, visibility }

    try {
      const ugcId = await this.convexClient.mutation(
        api.userGeneratedContent.createUGCItem,
        args
      );
      return this.formatResponse({
        success: true,
        data: ugcId as Id<"userGeneratedContent">,
        args: args
      });
    }
    catch (error) {
      console.error(`[WavedashJS] Error creating UGC item: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async uploadUGCItem(ugcId: Id<"userGeneratedContent">, filePath: string): Promise<string | WavedashResponse<Id<"userGeneratedContent">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    const args = { ugcId, filePath }

    try {
      const uploadUrl = await this.convexClient.mutation(
        api.userGeneratedContent.startUGCUpload,
        { ugcId: args.ugcId }
      );

      const success = await this.uploadFromIndexedDb(uploadUrl, args.filePath);
      await this.convexClient.mutation(
        api.userGeneratedContent.finishUGCUpload,
        { success: success, ugcId: args.ugcId }
      );

      return this.formatResponse({
        success: success,
        data: args.ugcId,
        args: args
      });
    }
    catch (error) {
      console.error(`[WavedashJS] Error uploading UGC item: ${error}`);
      await this.convexClient.mutation(
        api.userGeneratedContent.finishUGCUpload,
        { success: false, ugcId: args.ugcId }
      );
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  unsubscribeFromLobbyMessages(): void {
    if (this.lobbyMessagesUnsubscribeFn) {
      this.lobbyMessagesUnsubscribeFn();
      this.lobbyMessagesUnsubscribeFn = null;
      if (this.config?.debug) {
        console.log('[WavedashJS] Unsubscribed from lobby messages');
      }
    }
  }

  subscribeToLobbyMessages(lobbyId: string): void {
    // Unsubscribe from previous lobby if any
    this.unsubscribeFromLobbyMessages();
    
    // Subscribe to new lobby
    const { unsubscribe } = this.convexClient.onUpdate(
      api.gameLobby.lobbyMessages, 
      {
        lobbyId: lobbyId as Id<"lobbies">
      }, 
      (messages: any) => {
        console.log('[WavedashJS] Lobby messages updated:', messages);
        // Notify the game about new messages
        if (messages && messages.length > 0) {
          this.notifyLobbyMessage({
            id: lobbyId,
            messages: messages
          });
        }
      }
    );
    
    // Store the unsubscribe function
    this.lobbyMessagesUnsubscribeFn = unsubscribe;
    
    if (this.config?.debug) {
      console.log('[WavedashJS] Subscribed to lobby messages for:', lobbyId);
    }
  }

  async createLobby(lobbyType: number, maxPlayers?: number): Promise<string | WavedashResponse<Id<"lobbies">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    console.log('[WavedashJS] Creating lobby with type:', lobbyType, 'and max players:', maxPlayers);

    const args = {
      lobbyType: lobbyType as LobbyType,
      maxPlayers: maxPlayers
    };

    try {
      const lobbyId = await this.convexClient.mutation(
        api.gameLobby.createAndJoinLobby,
        args
      );

      if (this.config?.debug) {
        console.log('[WavedashJS] Lobby created:', lobbyId);
      }
      // Subscribe to lobby messages
      this.subscribeToLobbyMessages(lobbyId);
      
      return this.formatResponse({
        success: true,
        data: lobbyId,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error creating lobby: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async joinLobby(lobbyId: string): Promise<string | WavedashResponse<Id<"lobbies">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    const args = {
      lobbyId: lobbyId as Id<"lobbies">
    };

    try {
      const success = await this.convexClient.mutation(
        api.gameLobby.joinLobby,
        args
      );
      
      if (!success) {
        if (this.config?.debug) {
          console.log('[WavedashJS] Failed to join lobby:', lobbyId);
        }
        throw new Error(`Failed to join lobby: ${lobbyId}`);
      }
      
      // Subscribe to lobby messages
      this.subscribeToLobbyMessages(lobbyId);
      
      return this.formatResponse({
        success: true,
        data: lobbyId as Id<"lobbies">,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error joining lobby: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async leaveLobby(lobbyId: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    const args = {
      lobbyId: lobbyId as Id<"lobbies">
    };

    try {
      await this.convexClient.mutation(
        api.gameLobby.leaveLobby,
        args
      );
      
      // Clean up subscription
      this.unsubscribeFromLobbyMessages();
      
      if (this.config?.debug) {
        console.log('[WavedashJS] Left lobby:', lobbyId);
      }
      
      return this.formatResponse({
        success: true,
        data: true,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error leaving lobby: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async sendLobbyMessage(lobbyId: string, message: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    const args = {
      lobbyId: lobbyId as Id<"lobbies">,
      message: message
    };

    try {
      await this.convexClient.mutation(
        api.gameLobby.sendMessage,
        args
      );
      
      return this.formatResponse({
        success: true,
        data: true,
        args: args
      });
    } catch (error) {
      console.error(`[WavedashJS] Error sending lobby message: ${error}`);
      return this.formatResponse({
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  // =============================
  // JS -> Game Event Broadcasting
  // =============================

  notifyLobbyJoined(lobbyData: object): void {
    if (this.isReady()) {
      this.engineInstance!.SendMessage(
        this.engineCallbackReceiver,
        'LobbyJoined',
        JSON.stringify(lobbyData)
      );
    } else if (this.config?.debug) {
      console.warn('[WavedashJS] Engine instance not set. Call setEngineInstance() before calling notifyLobbyJoined().');
    }
  }

  notifyLobbyLeft(lobbyData: object): void {
    if (this.isReady()) {
      this.engineInstance!.SendMessage(
        this.engineCallbackReceiver,
        'LobbyLeft',
        JSON.stringify(lobbyData)
      );
    } else if (this.config?.debug) {
      console.warn('[WavedashJS] Engine instance not set. Call setEngineInstance() before calling notifyLobbyLeft().');
    }
  }

  notifyLobbyMessage(payload: object): void {
    if (this.isReady()) {
      this.engineInstance!.SendMessage(
        this.engineCallbackReceiver,
        'LobbyMessage',
        JSON.stringify(payload)
      );
    } else if (this.config?.debug) {
      console.warn('[WavedashJS] Engine instance not set. Call setEngineInstance() before calling notifyLobbyMessage().');
    }
  }
}

// Add to window
// if (typeof window !== 'undefined') {
//   (window as any).WavedashJS = new WavedashSDK();
// }

// Export for the website to use
export { WavedashSDK };

// Re-export all types
export type * from "./types";

// Type-safe initialization helper for the website
export function setupWavedashSDK(
  convexClient: ConvexClient,
  wavedashUser: WavedashUser,
): WavedashSDK {
  const sdk = new WavedashSDK(convexClient, wavedashUser);
  
  if (typeof window !== 'undefined') {
    (window as any).WavedashJS = sdk;
    console.log('[WavedashJS] SDK attached to window.WavedashJS');
  }

  
  return sdk;
}