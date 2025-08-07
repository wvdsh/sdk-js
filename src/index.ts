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
  WavedashResponse
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

  // ====================
  // Game -> JS functions
  // ====================

  init(config: WavedashConfig): void {
    if (!config) {
      console.error('[WavedashJS] Initialized with empty config');
      return;
    }
    if (typeof config === 'string') {
      try {
        config = JSON.parse(config);
      }
      catch (e) {
        console.error('[WavedashJS] Initialized with invalid config:', e);
        return;
      }
    }
  
    this.config = config;
    this.initialized = true;
    
    if (this.config.debug) {
      console.log('[WavedashJS] Initialized with config:', this.config);
    }
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
    return null;
  }

  async getLeaderboardEntriesForUsers(leaderboardId: Id<"leaderboards">, userIds: Id<"users">[]): Promise<string | WavedashResponse<LeaderboardEntries>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    if(this.config?.debug) {
      console.log('[WavedashJS] Getting leaderboard entries for users:', userIds);
    }
    // Game engines pass along structured data as JSON strings, so we need to parse them
    if (typeof userIds === 'string') {
      userIds = JSON.parse(userIds);
    }

    return this.handleAsyncOperation(
      () => this.convexClient.query(api.leaderboards.getLeaderboardEntriesForUsers, { leaderboardId: leaderboardId, userIds: userIds as Id<"users">[] })
    );
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
    const { getCurrentValue, unsubscribe } = this.convexClient.onUpdate(
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

    return this.handleAsyncOperation(
      async () => {
        const lobbyId = await this.convexClient.mutation(
          api.gameLobby.createAndJoinLobby,
          {
            lobbyType: lobbyType as LobbyType,
            maxPlayers: maxPlayers
          }
        );

        if (this.config?.debug) {
          console.log('[WavedashJS] Lobby created:', lobbyId);
        }
        // Subscribe to lobby messages
        this.subscribeToLobbyMessages(lobbyId);
        return lobbyId;
      },
    );
  }

  async joinLobby(lobbyId: string): Promise<string | WavedashResponse<Id<"lobbies">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    return this.handleAsyncOperation(
      async () => {
        const success = await this.convexClient.mutation(
          api.gameLobby.joinLobby,
          {
            lobbyId: lobbyId as Id<"lobbies">
          }
        );
        
        if (!success) {
          if (this.config?.debug) {
            console.log('[WavedashJS] Failed to join lobby:', lobbyId);
          }
          throw new Error(`Failed to join lobby: ${lobbyId}`);
        }
        
        // Subscribe to lobby messages
        this.subscribeToLobbyMessages(lobbyId);
        return lobbyId as Id<"lobbies">;
      },
    );
  }

  async leaveLobby(lobbyId: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    return this.handleAsyncOperation(
      async () => {
        await this.convexClient.mutation(
          api.gameLobby.leaveLobby,
          {
            lobbyId: lobbyId as Id<"lobbies">
          }
        );
        
        // Clean up subscription
        this.unsubscribeFromLobbyMessages();
        
        if (this.config?.debug) {
          console.log('[WavedashJS] Left lobby:', lobbyId);
        }
        return true;
      },
    );
  }

  async sendLobbyMessage(lobbyId: string, message: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    return this.handleAsyncOperation(
      async () => {
        await this.convexClient.mutation(
          api.gameLobby.sendMessage,
          {
            lobbyId: lobbyId as Id<"lobbies">,
            message: message
          }
        );
        return true;
      },
    );
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