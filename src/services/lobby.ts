/**
 * Lobby service
 *
 * Implements each of the lobby methods of the Wavedash SDK
 */

import type {
  Id,
  WavedashResponse,
  Lobby,
  LobbyVisibility,
  LobbyUser,
  LobbyMessage,
  WavedashUser
} from '../types';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';
import { LOBBY_MESSAGE_MAX_LENGTH } from '../_generated/constants';

export class LobbyManager {
  private sdk: WavedashSDK;

  // Track current lobby state
  private unsubscribeLobbyMessages: (() => void) | null = null;
  private unsubscribeLobbyUsers: (() => void) | null = null;
  private unsubscribeLobbyData: (() => void) | null = null;
  private lobbyId: Id<"lobbies"> | null = null;
  private lobbyUsers: LobbyUser[] = [];
  private lobbyHostId: Id<"users"> | null = null;
  private lobbyMetadata: Record<string, any> = {};
  private recentMessageIds: Id<"lobbyMessages">[] = [];

  // Cache results of queries for a list of lobbies
  // We'll cache metadata and num users for each lobby and return that info synchronously when requested by the game
  private cachedLobbies: Record<Id<"lobbies">, Lobby> = {};

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ================
  // Public Methods
  // ================

  async createLobby(visibility: LobbyVisibility, maxPlayers?: number): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = {
      visibility: visibility,
      maxPlayers: maxPlayers
    };

    try {
      const lobbyId = await this.sdk.convexClient.mutation(
        api.gameLobby.createAndJoinLobby,
        args
      );

      this.subscribeToLobby(lobbyId);

      // Initialize P2P connections for the newly created lobby
      // Since we just created the lobby, initially only we are in it
      await this.initializeP2PForLobby(lobbyId);

      return {
        success: true,
        data: lobbyId,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error creating lobby: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async joinLobby(lobbyId: Id<"lobbies">): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = { lobbyId };

    try {
      await this.sdk.convexClient.mutation(
        api.gameLobby.joinLobby,
        args
      );

      this.subscribeToLobby(lobbyId);

      // Initialize P2P connections with existing lobby members
      await this.initializeP2PForLobby(lobbyId);

      // Do we need this? We already return the lobby id in the Promise
      // Assuming a user can join a lobby from the Wavedash UI, in addition to game UI, so game needs a notification
      this.sdk.notifyGame(Signals.LOBBY_JOINED, lobbyId);
      return {
        success: true,
        data: lobbyId,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error joining lobby: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  getLobbyUsers(lobbyId: Id<"lobbies">): LobbyUser[] {
    if (this.lobbyId !== lobbyId) {
      this.sdk.logger.error('Must be a member of the lobby to access user list');
      return [];
    }
    return this.lobbyUsers;
  }

  getHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    if (this.lobbyId !== lobbyId) {
      this.sdk.logger.error('Must be a member of the lobby to access the host ID');
      return null;
    }
    return this.lobbyHostId;
  }

  getLobbyData(lobbyId: Id<"lobbies">, key: string): string {
    // Current lobby has a subscription, so we can get the data directly
    if (this.lobbyId === lobbyId) {
      return this.lobbyMetadata[key] || '';
    }
    // Otherwise return the latest cached data from listed lobbies
    if (!this.cachedLobbies[lobbyId]) {
      return '';
    }
    return this.cachedLobbies[lobbyId].metadata[key] || '';
  }

  getLobbyMaxPlayers(lobbyId: Id<"lobbies">): number {
    if (!this.cachedLobbies[lobbyId]) {
      return 0;
    }
    return this.cachedLobbies[lobbyId].maxPlayers;
  }

  getLobbyPlayerCount(lobbyId: Id<"lobbies">): number {
    if (this.lobbyId === lobbyId) {
      return this.lobbyUsers.length;
    }
    if (!this.cachedLobbies[lobbyId]) {
      return 0;
    }
    return this.cachedLobbies[lobbyId].playerCount;
  }

  async leaveLobby(lobbyId: Id<"lobbies">): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = { lobbyId };

    try {
      await this.sdk.convexClient.mutation(
        api.gameLobby.leaveLobby,
        args
      );

      // Disconnect from all P2P peers before unsubscribing from lobby
      await this.sdk.p2pManager.disconnectP2P();

      this.unsubscribeFromCurrentLobby();

      return {
        success: true,
        data: lobbyId,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error leaving lobby: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listAvailableLobbies(): Promise<WavedashResponse<Lobby[]>> {
    // TODO: Implement query filters
    const args = {};
    try {
      const lobbies = await this.sdk.convexClient.query(
        api.gameLobby.listAvailable,
        args
      );  
      for (const lobby of lobbies) {
        this.cachedLobbies[lobby.lobbyId] = lobby;
      }
      return {
        success: true,
        data: lobbies,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error listing available lobbies: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    const args = { lobbyId, message };
    if (message.length === 0) {
      this.sdk.logger.error('Message cannot be empty');
      return false;
    }
    if (message.length > LOBBY_MESSAGE_MAX_LENGTH) {
      this.sdk.logger.error(`Message cannot be longer than ${LOBBY_MESSAGE_MAX_LENGTH} characters`);
      return false;
    }
    this.sdk.convexClient.mutation(
      api.gameLobby.sendMessage,
      args
    ).catch((error) => {
      this.sdk.logger.error(`Error sending lobby message: ${error}`);
      return false;
    });

    return true;
  }

  // ================
  // Private Methods
  // ================

  /**
   * Sets up Convex subscriptions for all relevant lobby updates
   * @precondition - The user has already joined the lobby
   * @param lobbyId - The ID of the lobby to subscribe to
   */
  private subscribeToLobby(lobbyId: Id<"lobbies">): void {
    // Unsubscribe from previous lobby if any
    this.unsubscribeFromCurrentLobby();

    this.lobbyId = lobbyId;

    // Subscribe to lobby messages
    this.unsubscribeLobbyMessages = this.sdk.convexClient.onUpdate(
      api.gameLobby.lobbyMessages,
      { lobbyId },
      this.processMessageUpdates,
    );

    this.unsubscribeLobbyData = this.sdk.convexClient.onUpdate(
      api.gameLobby.getLobbyMetadata,
      { lobbyId },
      (lobbyMetadata: Record<string, any>) => {
        this.lobbyMetadata = lobbyMetadata;
        this.sdk.notifyGame(Signals.LOBBY_DATA_UPDATED, lobbyMetadata);
      }
    );

    // Subscribe to lobby users
    this.unsubscribeLobbyUsers = this.sdk.convexClient.onUpdate(
      api.gameLobby.lobbyUsers,
      { lobbyId },
      this.processUserUpdates,
    );

    this.sdk.logger.debug('Subscribed to lobby:', lobbyId);
  }

  private unsubscribeFromCurrentLobby(): void {
    if (this.unsubscribeLobbyMessages) {
      this.unsubscribeLobbyMessages();
      this.unsubscribeLobbyMessages = null;
    }
    if (this.unsubscribeLobbyUsers) {
      this.unsubscribeLobbyUsers();
      this.unsubscribeLobbyUsers = null;
    }
    if (this.unsubscribeLobbyData) {
      this.unsubscribeLobbyData();
      this.unsubscribeLobbyData = null;
    }

    // Clean up P2P connections when leaving lobby
    this.sdk.p2pManager.disconnectP2P().catch(error => {
      this.sdk.logger.error('Error disconnecting P2P during cleanup:', error);
    });

    this.lobbyId = null;
    this.lobbyUsers = [];
    this.lobbyHostId = null;
    this.lobbyMetadata = {};
    this.recentMessageIds = [];
  }

  /**
   * Process user updates and emit individual user events
   * @param newUsers - The updated list of lobby users
   */
  private processUserUpdates = (newUsers: LobbyUser[]): void => {
    const previousUsers = this.lobbyUsers;
    const previousUserIds = new Set(previousUsers.map(user => user.userId));
    const newUserIds = new Set(newUsers.map(user => user.userId));

    // Find users who joined
    for (const user of newUsers) {
      if (user.isHost) {
        this.lobbyHostId = user.userId;
      }
      if (!previousUserIds.has(user.userId)) {
        this.sdk.notifyGame(Signals.LOBBY_USERS_UPDATED, {
          ...user,
          changeType: 'JOINED'
        });
      }
    }

    // Find users who left
    for (const user of previousUsers) {
      if (!newUserIds.has(user.userId)) {
        // For now, we can't distinguish between LEFT, DISCONNECTED, or KICKED
        // from the basic lobby users update. Default to LEFT.
        this.sdk.notifyGame(Signals.LOBBY_USERS_UPDATED, {
          ...user,
          changeType: 'LEFT'
        });
      }
    }

    // Update P2P connections when lobby membership changes
    if (this.lobbyId && (previousUsers.length !== newUsers.length || 
        previousUserIds.size !== newUserIds.size || 
        [...previousUserIds].some(id => !newUserIds.has(id)))) {
      this.updateP2PConnections(newUsers);
    }

    this.lobbyUsers = newUsers;
  }

  private processMessageUpdates = (newMessages: LobbyMessage[]): void => {
    for (const message of newMessages) {
      if (!this.recentMessageIds.includes(message.messageId)) {
        this.sdk.notifyGame(Signals.LOBBY_MESSAGE, message);
      }
    }
    this.recentMessageIds = newMessages.map(message => message.messageId);
  }

  // ================
  // P2P Integration Methods
  // ================

  /**
   * Initialize P2P connections for the current lobby
   * @param lobbyId - The lobby ID to initialize P2P for
   */
  private async initializeP2PForLobby(lobbyId: Id<"lobbies">): Promise<void> {
    try {
      // Wait a moment for lobby subscriptions to populate users
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Convert LobbyUser[] to WavedashUser[] for P2P manager
      const wavedashUsers: WavedashUser[] = this.lobbyUsers.map(lobbyUser => ({
        id: lobbyUser.userId,
        username: lobbyUser.username
      }));

      // Only initialize P2P if there are other users to connect to
      if (wavedashUsers.length > 1) {
        const result = await this.sdk.p2pManager.initializeP2PForCurrentLobby(lobbyId, wavedashUsers);
        if (!result.success) {
          this.sdk.logger.error('Failed to initialize P2P connections:', result.message);
        } else {
          this.sdk.logger.debug(`P2P initialized for lobby ${lobbyId} with ${wavedashUsers.length} users`);
        }
      } else {
        this.sdk.logger.debug('No other users in lobby, P2P initialization skipped');
      }
    } catch (error) {
      this.sdk.logger.error('Error initializing P2P for lobby:', error);
    }
  }

  /**
   * Update P2P connections when lobby membership changes
   * @param newUsers - The updated list of lobby users
   */
  private async updateP2PConnections(newUsers: LobbyUser[]): Promise<void> {
    if (!this.lobbyId) {
      return;
    }

    try {
      // Convert LobbyUser[] to WavedashUser[] for P2P manager
      const wavedashUsers: WavedashUser[] = newUsers.map(lobbyUser => ({
        id: lobbyUser.userId,
        username: lobbyUser.username
      }));

      // Reinitialize P2P connections with the updated user list
      if (wavedashUsers.length > 1) {
        const result = await this.sdk.p2pManager.initializeP2PForCurrentLobby(this.lobbyId, wavedashUsers);
        if (!result.success) {
          this.sdk.logger.error('Failed to update P2P connections:', result.message);
        } else {
          this.sdk.logger.debug(`P2P connections updated for lobby ${this.lobbyId} with ${wavedashUsers.length} users`);
        }
      } else {
        // If only one user left, disconnect all P2P connections
        await this.sdk.p2pManager.disconnectP2P();
        this.sdk.logger.debug('Only one user remaining, P2P connections disconnected');
      }
    } catch (error) {
      this.sdk.logger.error('Error updating P2P connections:', error);
    }
  }
}