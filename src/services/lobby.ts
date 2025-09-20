/**
 * Lobby service
 *
 * Implements each of the lobby methods of the Wavedash SDK
 */

import type {
  Id,
  WavedashResponse,
  LobbyType,
  LobbyUsers,
  Signal
} from '../types';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';

export class LobbyManager {
  private sdk: WavedashSDK;

  private unsubscribeLobbyMessages: (() => void) | null = null;
  private unsubscribeLobbyUsers: (() => void) | null = null;
  private unsubscribeLobbyData: (() => void) | null = null;
  private currentLobbyId: Id<"lobbies"> | null = null;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ================
  // Public Methods
  // ================

  async createLobby(lobbyType: LobbyType, maxPlayers?: number): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = {
      lobbyType: lobbyType,
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

  async getLobbyUsers(lobbyId: Id<"lobbies">): Promise<WavedashResponse<LobbyUsers>> {
    const args = { lobbyId };
    try {
      const users = await this.sdk.convexClient.query(
        api.gameLobby.lobbyUsers,
        args
      );
      return {
        success: true,
        data: users,
        args: args
      };
    } catch (error) {
      this.sdk.logger.error(`Error getting lobby users: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
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

  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    const args = { lobbyId, message };

    try {
      this.sdk.convexClient.mutation(
        api.gameLobby.sendMessage,
        args
      );

      return true;
    } catch (error) {
      this.sdk.logger.error(`Error sending lobby message: ${error}`);
      return false;
    }
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

    this.currentLobbyId = lobbyId;

    // Subscribe to lobby messages
    this.unsubscribeLobbyMessages = this.sdk.convexClient.onUpdate(
      api.gameLobby.lobbyMessages,
      {
        lobbyId: lobbyId
      },
      (messages: any) => {
        this.sdk.logger.info('Lobby messages updated:', messages);
        // Notify the game about new messages
        if (messages && messages.length > 0) {
          this.sdk.notifyGame(Signals.LOBBY_MESSAGE, {
            id: lobbyId,
            // TODO: Only send one message at a time
            messages: messages
          });
        }
      }
    );

    // Subscribe to lobby users
    this.unsubscribeLobbyUsers = this.sdk.convexClient.onUpdate(
      api.gameLobby.lobbyUsers,
      {
        lobbyId: lobbyId
      },
      (users: any) => {
        this.sdk.logger.info('Lobby users updated:', users);
        // Notify the game about new users
        if (users && users.length > 0) {
          this.sdk.notifyGame(Signals.LOBBY_USERS_UPDATED, {
            id: lobbyId,
            users: users
          });
        }
      }
    );

    this.sdk.logger.debug('Subscribed to lobby messages for:', lobbyId);
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
    this.currentLobbyId = null;
  }
}