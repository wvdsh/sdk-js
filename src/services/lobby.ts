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
  LobbyMessage
} from '../types';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';

export class LobbyManager {
  private sdk: WavedashSDK;

  // Track current lobby state
  private unsubscribeLobbyMessages: (() => void) | null = null;
  private unsubscribeLobbyUsers: (() => void) | null = null;
  private unsubscribeLobbyData: (() => void) | null = null;
  private lobbyId: Id<"lobbies"> | null = null;
  private lobbyUsers: LobbyUser[] = [];
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
      this.sdk.logger.error('Lobby ID does not match the current lobby');
      return [];
    }
    return this.lobbyUsers;
  }

  getHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    if (this.lobbyId !== lobbyId) {
      this.sdk.logger.error('Lobby ID does not match the current lobby');
      return null;
    }
    return this.lobbyUsers.find(user => user.isHost)?.userId || null;
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
    const args = {};
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
  }

  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    const args = { lobbyId, message };
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
      {
        lobbyId: lobbyId
      },
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

    this.sdk.logger.debug('Subscribed to lobby::', lobbyId);
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
    this.lobbyId = null;
    this.lobbyUsers = [];
    this.lobbyMetadata = {};
    this.recentMessageIds = [];
  }

  /**
   * Process user updates and emit individual user events
   * @param newUsers - The updated list of lobby users
   */
  private processUserUpdates(newUsers: LobbyUser[]): void {
    const previousUsers = this.lobbyUsers;
    const previousUserIds = new Set(previousUsers.map(user => user.userId));
    const newUserIds = new Set(newUsers.map(user => user.userId));

    // Find users who joined
    for (const user of newUsers) {
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

    this.lobbyUsers = newUsers;
  }

  private processMessageUpdates(newMessages: LobbyMessage[]): void {
    for (const message of newMessages) {
      if (!this.recentMessageIds.includes(message.messageId)) {
        // Add new message ID and maintain sliding window of 10
        this.recentMessageIds.push(message.messageId);
        if (this.recentMessageIds.length > 10) {
          this.recentMessageIds.shift(); // Remove oldest
        }
        this.sdk.notifyGame(Signals.LOBBY_MESSAGE, message);
      }
    }
  }
}