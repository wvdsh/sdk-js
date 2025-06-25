import { ConvexClient } from "convex/browser";
import { api } from "./convex_api";
import { type GenericId as Id } from "convex/values";

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
  private wavedashUser: WavedashUser | null = null;
  private convexClient: ConvexClient;
  private gameSessionToken: string;
  
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

    if (this.wavedashUser) {
      return JSON.stringify(this.wavedashUser);
    }

    return null;
  }

  isReady(): boolean {
    return this.initialized;
  }

  // TODO Resolve promises here rather than manually calling notifyLobbyJoined
  async createLobby(): Promise<Id<"lobbies">> {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      throw new Error('SDK not initialized');
    }

    try {
      const lobbyId = await this.convexClient.mutation(
        api.gameLobby.createAndJoinLobby,
        {
          gameSessionToken: this.gameSessionToken,
        }
      );

      if (this.config?.debug) {
        console.log('[WavedashJS] Lobby created:', lobbyId);
      }
      if (lobbyId) {
        this.notifyLobbyJoined({
          id: lobbyId
        });
      } else {
        // TODO: Set up error callbacks
        console.error('[WavedashJS] Failed to create lobby');
      }

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
      return JSON.stringify({
        success: success,
        id: lobbyId
      });
    } catch (error) {
      console.error('[WavedashJS] Failed to join lobby:', error);
      throw error;
    }
  }

  // =============================
  // JS -> Game Event Broadcasting
  // =============================

  // TODO these should all be handled by the Unity JS Lib
  notifyLobbyJoined(lobbyData: object): void {
    if (this.initialized && this.engineInstance) {
      this.engineInstance.SendMessage(
        this.engineCallbackReceiver,
        'LobbyJoined',
        JSON.stringify(lobbyData)
      );
    } else if (this.config?.debug) {
      console.warn('[WavedashJS] Engine instance not set. Call setEngineInstance() before calling notifyLobbyJoined().');
    }
  }

  notifyLobbyLeft(lobbyData: object): void {
    if (this.initialized && this.engineInstance) {
      this.engineInstance.SendMessage(
        this.engineCallbackReceiver,
        'LobbyLeft',
        JSON.stringify(lobbyData)
      );
    } else if (this.config?.debug) {
      console.warn('[WavedashJS] Engine instance not set. Call setEngineInstance() before calling notifyLobbyLeft().');
    }
  }

  notifyLobbyMessage(payload: object): void {
    if (this.initialized && this.engineInstance) {
      this.engineInstance.SendMessage(
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