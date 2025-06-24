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

interface UnityInstance {
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
  // ... other internal properties and methods
}

class WavedashSDK {
  private initialized: boolean = false;
  private config: WavedashConfig | null = null;
  private unityInstance: UnityInstance | null = null;
  private unityCallbackReceiver: string | null = null;
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
    this.config = config;
    this.initialized = true;
    
    if (this.config.debug) {
      console.log('[WavedashJS] Initialized with config:', this.config);
    }
  }

  // TODO: This is a Unity-specific solution for JS triggering callbacks in the game.
  // Come up with a general solution or move this into a separate wavedash/unity package.
  setUnityInstance(unityInstance: UnityInstance): void {
    // This is called in the BROWSER in a custom loading script.
    this.unityInstance = unityInstance;
  }

  // TODO: This is a Unity-specific solution for JS triggering callbacks in the game.
  // Come up with a general solution or move this into a separate wavedash/unity package.
  registerUnityCallbackReceiver(unityCallbackGameObjectName: string): void {
    // This is called in UNITY when the Unity Wavedash SDK is initialized.
    this.unityCallbackReceiver = unityCallbackGameObjectName;
  }

  getUser(): WavedashUser | null {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      return null;
    }

    if (this.wavedashUser) {
      return this.wavedashUser;
    }

    return null;
  }

  isReady(): boolean {
    return this.initialized;
  }

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

  async joinLobby(lobbyId: string): Promise<boolean> {
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
      if (success) {
        this.notifyLobbyJoined({
          id: lobbyId
        });
      } else {
        // TODO: Set up error callbacks
        console.error('[WavedashJS] Failed to join lobby:', lobbyId);
      }

      return success;
    } catch (error) {
      console.error('[WavedashJS] Failed to join lobby:', error);
      throw error;
    }
  }

  // ============================
  // JS -> Game Callback Triggers
  // ============================

  notifyLobbyJoined(lobbyData: object): void {
    if (this.initialized && this.unityInstance && this.unityCallbackReceiver) {
      this.unityInstance.SendMessage(
        this.unityCallbackReceiver,
        'OnLobbyJoinedCallback',
        JSON.stringify(lobbyData)
      );
    } else {
      console.warn('[WavedashJS] Unity instance not set. Call setUnityInstance() before calling notifyLobbyJoined().');
    }
  }

  notifyLobbyLeft(lobbyData: object): void {
    if (this.initialized && this.unityInstance && this.unityCallbackReceiver) {
      this.unityInstance.SendMessage(
        this.unityCallbackReceiver,
        'OnLobbyLeftCallback',
        JSON.stringify(lobbyData)
      );
    }
  }

  notifyLobbyMessage(payload: object): void {
    if (this.initialized && this.unityInstance && this.unityCallbackReceiver) {
      this.unityInstance.SendMessage(
        this.unityCallbackReceiver,
        'OnLobbyMessageCallback',
        JSON.stringify(payload)
      );
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