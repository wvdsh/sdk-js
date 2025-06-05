interface WavedashConfig {
  gameId: string;
  debug?: boolean;
}

interface WavedashUser {
  id: string;
  username: string;
  email: string;
}

interface UnityInstance {
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
  // ... other internal properties and methods
}

class WavedashSDK {
  private initialized: boolean = false;
  private config: WavedashConfig | null = null;
  private unityInstance: UnityInstance | null = null;
  private unityCallbackGameObjectName: string | null = null;
  private wavedashUser: WavedashUser | null = null;

  async init(config: WavedashConfig): Promise<void> {
    this.config = config;
    this.initialized = true;
    
    if (this.config.debug) {
      console.log('[WavedashJS] Initialized with config:', this.config);
    }
  }

  // TODO: This is a Unity-specific solution for JS triggering callbacks in the game.
  // Come up with a general solution or move this into a separate wavedash/unity package.
  setUnityInstance(unityInstance: UnityInstance, unityCallbackGameObjectName: string): void {
    console.log('[WavedashJS] Setting Unity instance:', unityInstance, unityCallbackGameObjectName);
    this.unityInstance = unityInstance;
    this.unityCallbackGameObjectName = unityCallbackGameObjectName;
  }

  getUser(): WavedashUser | null {
    if (!this.initialized) {
      console.warn('[WavedashJS] SDK not initialized. Call init() first.');
      return null;
    }

    if (this.wavedashUser) {
      return this.wavedashUser;
    }

    // Check for user data on window
    if ((window as any).wavedashUser) {
      this.wavedashUser = (window as any).wavedashUser;
      return this.wavedashUser;
    }

    return null;
  }

  isReady(): boolean {
    return this.initialized;
  }

  notifyLobbyJoined(lobbyData: object): void {
    if (this.unityInstance && this.unityCallbackGameObjectName) {
      console.log('[WavedashJS] Notifying Unity that lobby was joined:', lobbyData);
      this.unityInstance.SendMessage(
        this.unityCallbackGameObjectName,
        'OnLobbyJoinedCallback',
        JSON.stringify(lobbyData)
      );
    } else {
      console.warn('[WavedashJS] Unity instance not set. Call setUnityInstance() before calling notifyLobbyJoined().');
    }
  }
}

// Add to window
if (typeof window !== 'undefined') {
  (window as any).WavedashJS = new WavedashSDK();
} 