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
  LeaderboardEntry,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry
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

  async getMyLeaderboardEntry(leaderboardId: Id<"leaderboards">): Promise<string | WavedashResponse<LeaderboardEntry>> {
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
      
      return this.formatResponse({
        success: true,
        data: entry,
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

  async uploadLeaderboardScore(leaderboardId: Id<"leaderboards">, score: number, keepBest: boolean, metadata?: ArrayBuffer): Promise<string | WavedashResponse<UpsertedLeaderboardEntry>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    if(this.config?.debug) {
      console.log(`[WavedashJS] Uploading score ${score} to leaderboard: ${leaderboardId}`);
    }

    const args = { leaderboardId, score, keepBest, metadata }
    
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