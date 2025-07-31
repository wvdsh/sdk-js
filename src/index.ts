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

    return this.formatResponse(this.wavedashUser) as string | WavedashUser;
  }

  isReady(): boolean {
    return this.initialized;
  }

  async getLeaderboard(leaderboardName: string): Promise<string | WavedashResponse<Leaderboard>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      const leaderboard = await this.convexClient.query(
        api.leaderboards.getLeaderboard,
        {
          name: leaderboardName
        }
      );
      if (leaderboard) {
        return this.formatResponse({success: true, data: leaderboard});
      } else {
        return this.formatResponse({success: false, data: null, message: "Leaderboard does not exist"});
      }
    } catch (error) {
      console.error('[WavedashJS] Failed to get leaderboard:', error);
      return this.formatResponse({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async getOrCreateLeaderboard(leaderboardName: string, sortMethod: LeaderboardSortMethod, displayType: LeaderboardDisplayType): Promise<string | WavedashResponse<Leaderboard>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      const leaderboard = await this.convexClient.mutation(
        api.leaderboards.getOrCreateLeaderboard,
        {
          name: leaderboardName,
          sortOrder: sortMethod,
          displayType: displayType
        }
      );
      return this.formatResponse({
        success: true,
        data: leaderboard
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to get or create leaderboard:', error);
      return this.formatResponse({
        success: false,
        data: null,
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

    try {
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
      return this.formatResponse({
        success: true,
        data: lobbyId
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to create lobby:', error);
      return this.formatResponse({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async joinLobby(lobbyId: string): Promise<string | WavedashResponse<Id<"lobbies">>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      const success = await this.convexClient.mutation(
        api.gameLobby.joinLobby,
        {
          lobbyId: lobbyId as Id<"lobbies">
        }
      );
      if (success) {
        // Subscribe to lobby messages
        this.subscribeToLobbyMessages(lobbyId);
        return this.formatResponse({
          success: true,
          data: lobbyId as Id<"lobbies">
        });
      } else {
        if (this.config?.debug) {
          console.log('[WavedashJS] Failed to join lobby:', lobbyId);
        }
        return this.formatResponse({
          success: false,
          data: null,
          message: `Failed to join lobby: ${lobbyId}`
        });
      }
    } catch (error) {
      console.error('[WavedashJS] Failed to join lobby:', error);
      return this.formatResponse({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async leaveLobby(lobbyId: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
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
      return this.formatResponse({
        success: true,
        data: true
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to leave lobby:', error);
      return this.formatResponse({
        success: false,
        data: null,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async sendLobbyMessage(lobbyId: string, message: string): Promise<string | WavedashResponse<boolean>> {
    if (!this.isReady()) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      await this.convexClient.mutation(
        api.gameLobby.sendMessage,
        {
          lobbyId: lobbyId as Id<"lobbies">,
          message: message
        }
      );
      return this.formatResponse({
        success: true,
        data: true
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to send lobby message:', error);
      return this.formatResponse({
        success: false,
        data: null,
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