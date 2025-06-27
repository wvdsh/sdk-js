import { ConvexClient } from "convex/browser";
import { api, PublicApiType } from "./convex_api";
import { type GenericId as Id } from "convex/values";

// Extract the lobbyType from the API type
type LobbyType = PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["lobbyType"];

interface WavedashConfig {
  gameId: string;
  debug?: boolean;
}

interface WavedashUser {
  id: string;
  username: string;
}

interface EngineInstance {
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
  // ... other internal properties and methods
}

class WavedashSDK {
  private initialized: boolean = false;
  private config: WavedashConfig | null = null;
  private engineInstance: EngineInstance | null = null;
  private engineCallbackReceiver: string = "WavedashCallbackReceiver";
  private wavedashUser: WavedashUser;
  private convexClient: ConvexClient;
  private gameSessionToken: string;
  private lobbyMessagesUnsubscribeFn: (() => void) | null = null;
  
  constructor(convexClient: ConvexClient, gameSessionToken: string, wavedashUser: WavedashUser) {
    this.convexClient = convexClient;
    this.gameSessionToken = gameSessionToken;
    this.wavedashUser = wavedashUser;
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

  getUser(): string | null {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      return null;
    }

    return JSON.stringify(this.wavedashUser);
  }

  isReady(): boolean {
    return this.initialized && this.engineInstance !== null && this.engineInstance !== undefined;
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
        gameSessionToken: this.gameSessionToken,
        lobbyId: lobbyId as Id<"lobbies">
      }, 
      (messages) => {
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

  async createLobby(lobbyType: string, maxPlayers?: number): Promise<Id<"lobbies">> {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    console.log('[WavedashJS] Creating lobby with type:', lobbyType, 'and max players:', maxPlayers);

    try {
      const lobbyId = await this.convexClient.mutation(
        api.gameLobby.createAndJoinLobby,
        {
          gameSessionToken: this.gameSessionToken,
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
    } catch (error) {
      console.error('[WavedashJS] Failed to create lobby:', error);
      throw error;
    }
  }

  async joinLobby(lobbyId: string): Promise<string> {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      const success = await this.convexClient.mutation(
        api.gameLobby.joinLobby,
        {
          gameSessionToken: this.gameSessionToken,
          lobbyId: lobbyId as Id<"lobbies">
        }
      );

      if (this.config?.debug) {
        console.log('[WavedashJS] Lobby joined:', lobbyId, success);
      }
      // Subscribe to lobby messages
      this.subscribeToLobbyMessages(lobbyId);
      return JSON.stringify({
        success: success,
        id: lobbyId
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to join lobby:', error);
      throw error;
    }
  }

  async leaveLobby(lobbyId: string): Promise<void> {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      await this.convexClient.mutation(
        api.gameLobby.leaveLobby,
        {
          gameSessionToken: this.gameSessionToken,
          lobbyId: lobbyId as Id<"lobbies">
        }
      );
      
      // Clean up subscription
      this.unsubscribeFromLobbyMessages();
      
      if (this.config?.debug) {
        console.log('[WavedashJS] Left lobby:', lobbyId);
      }
    } catch (error) {
      console.error('[WavedashJS] Failed to leave lobby:', error);
      throw error;
    }
  }

  async sendLobbyMessage(lobbyId: string, message: string): Promise<void> {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }
    
    try {
      await this.convexClient.mutation(
        api.gameLobby.sendMessage,
        {
          gameSessionToken: this.gameSessionToken,
          lobbyId: lobbyId as Id<"lobbies">,
          message: message
        }
      );
    } catch (error) {
      console.error('[WavedashJS] Failed to send lobby message:', error);
      throw error;
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
  gameSessionToken: string,
  wavedashUser: WavedashUser,
): WavedashSDK {
  const sdk = new WavedashSDK(convexClient, gameSessionToken, wavedashUser);
  
  if (typeof window !== 'undefined') {
    (window as any).WavedashJS = sdk;
    console.log('[WavedashJS] SDK attached to window.WavedashJS');
  }
  
  return sdk;
}