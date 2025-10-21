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
  WavedashUser,
} from "../types";
import { Signals } from "../signals";
import { api } from "../_generated/convex_api";
import type { WavedashSDK } from "../index";
import { LOBBY_MESSAGE_MAX_LENGTH } from "../_generated/constants";

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
  private lobbyDataUpdateTimeout: number | null = null;
  private maybeBeingDeletedLobbyIds: Set<Id<"lobbies">> = new Set();
  private resetMaybeBeingDeletedLobbyIdTimeouts: Map<Id<"lobbies">, number> =
    new Map();

  // Cache results of queries for a list of lobbies
  // We'll cache metadata and num users for each lobby and return that info synchronously when requested by the game
  private cachedLobbies: Record<Id<"lobbies">, Lobby> = {};

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ================
  // Public Methods
  // ================

  async createLobby(
    visibility: LobbyVisibility,
    maxPlayers?: number
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = {
      visibility: visibility,
      maxPlayers: maxPlayers,
    };

    try {
      const lobbyId = await this.sdk.convexClient.mutation(
        api.gameLobby.createAndJoinLobby,
        args
      );

      this.subscribeToLobby(lobbyId);
      this.lobbyHostId = this.sdk.getUserId();
      this.lobbyId = lobbyId;
      // P2P will be initialized when processUserUpdates receives the lobby users

      return {
        success: true,
        data: lobbyId,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error creating lobby: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Join a lobby
   * @param lobbyId - The ID of the lobby to join
   * @returns A WavedashResponse containing the lobby ID
   * @emits LOBBY_JOINED signal to the game engine
   */
  async joinLobby(
    lobbyId: Id<"lobbies">
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = { lobbyId };

    try {
      await this.sdk.convexClient.mutation(api.gameLobby.joinLobby, args);

      this.subscribeToLobby(lobbyId);
      // P2P will be initialized separately when processUserUpdates receives the lobby users

      const response = {
        success: true,
        data: lobbyId,
        args: args,
      };

      this.sdk.notifyGame(Signals.LOBBY_JOINED, response);

      return response;
    } catch (error) {
      this.sdk.logger.error(`Error joining lobby: ${error}`);
      const response = {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error),
      };
      this.sdk.notifyGame(Signals.LOBBY_JOINED, response);
      return response;
    }
  }

  getLobbyUsers(lobbyId: Id<"lobbies">): LobbyUser[] {
    if (this.lobbyId !== lobbyId) {
      this.sdk.logger.error(
        "Must be a member of the lobby to access user list"
      );
      return [];
    }
    return this.lobbyUsers;
  }

  getHostId(lobbyId: Id<"lobbies">): Id<"users"> | null {
    if (this.lobbyId !== lobbyId) {
      this.sdk.logger.error(
        "Must be a member of the lobby to access the host ID"
      );
      return null;
    }
    return this.lobbyHostId;
  }

  getLobbyData(lobbyId: Id<"lobbies">, key: string): string {
    // Current lobby has a subscription, so we can get the data directly
    if (this.lobbyId === lobbyId) {
      return this.lobbyMetadata[key] || "";
    }
    // Otherwise return the latest cached data from listed lobbies
    if (!this.cachedLobbies[lobbyId]) {
      return "";
    }
    return this.cachedLobbies[lobbyId].metadata[key] || "";
  }

  // Set synchronously here and batch updates to the backend in a single request
  // That way game can easily set all the data it needs in sequential calls without multiple network requests
  setLobbyData(lobbyId: Id<"lobbies">, key: string, value: any): boolean {
    if (this.lobbyId === lobbyId && this.lobbyHostId === this.sdk.getUserId()) {
      if (this.lobbyMetadata[key] !== value) {
        this.lobbyMetadata[key] = value;
        if (!this.lobbyDataUpdateTimeout) {
          this.sdk.logger.debug("Setting timeout for lobby data update");
          this.lobbyDataUpdateTimeout = setTimeout(() => {
            this.processPendingLobbyDataUpdates();
            this.lobbyDataUpdateTimeout = null;
            this.sdk.logger.debug("Removing timeout for lobby data update");
          }, 10);
        }
      }
      return true;
    }
    return false;
  }

  getLobbyMaxPlayers(lobbyId: Id<"lobbies">): number {
    if (!this.cachedLobbies[lobbyId]) {
      return 0;
    }
    return this.cachedLobbies[lobbyId].maxPlayers;
  }

  getNumLobbyUsers(lobbyId: Id<"lobbies">): number {
    if (this.lobbyId === lobbyId) {
      return this.lobbyUsers.length;
    }
    if (!this.cachedLobbies[lobbyId]) {
      return 0;
    }
    return this.cachedLobbies[lobbyId].playerCount;
  }

  async leaveLobby(
    lobbyId: Id<"lobbies">
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = { lobbyId };

    try {
      // Clean up subscriptions BEFORE leaving lobby so we don't trigger updates to ourselves from leaving
      this.unsubscribeFromCurrentLobby();

      // Now we can leave the lobby
      await this.sdk.convexClient.mutation(api.gameLobby.leaveLobby, args);

      return {
        success: true,
        data: lobbyId,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error leaving lobby: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error),
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

      // Filter out lobbies that are being deleted
      const filteredLobbies = lobbies.filter(
        (lobby) => !this.maybeBeingDeletedLobbyIds.has(lobby.lobbyId)
      );

      for (const lobby of filteredLobbies) {
        this.cachedLobbies[lobby.lobbyId] = lobby;
      }
      return {
        success: true,
        data: filteredLobbies,
        args: args,
      };
    } catch (error) {
      this.sdk.logger.error(`Error listing available lobbies: ${error}`);
      return {
        success: false,
        data: null,
        args: args,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  sendLobbyMessage(lobbyId: Id<"lobbies">, message: string): boolean {
    const args = { lobbyId, message };
    if (message.length === 0) {
      this.sdk.logger.error("Message cannot be empty");
      return false;
    }
    if (message.length > LOBBY_MESSAGE_MAX_LENGTH) {
      this.sdk.logger.error(
        `Message cannot be longer than ${LOBBY_MESSAGE_MAX_LENGTH} characters`
      );
      return false;
    }
    try {
      // Fire and forget, not awaiting the result
      this.sdk.convexClient.mutation(api.gameLobby.sendMessage, args);
    } catch (error) {
      this.sdk.logger.error(`Error sending lobby message: ${error}`);
      return false;
    }

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
      this.processMessageUpdates
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
      this.processUserUpdates
    );

    this.sdk.logger.debug("Subscribed to lobby:", lobbyId);
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
    this.sdk.p2pManager.disconnectP2P();

    // If we're leaving as the last user in the lobby, it's going to be deleted unless someone else joined right as we left
    // Temporarily track this lobby ID so we don't list it as available
    if (this.lobbyId && this.lobbyUsers.length === 1) {
      const lobbyId = this.lobbyId;

      // Clear any existing timeout for this lobby
      const existingTimeout =
        this.resetMaybeBeingDeletedLobbyIdTimeouts.get(lobbyId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Track this lobby as potentially being deleted
      this.maybeBeingDeletedLobbyIds.add(lobbyId);

      // Set timeout to remove it from the set after 500ms
      const timeoutId = setTimeout(() => {
        this.maybeBeingDeletedLobbyIds.delete(lobbyId);
        this.resetMaybeBeingDeletedLobbyIdTimeouts.delete(lobbyId);
      }, 500);

      this.resetMaybeBeingDeletedLobbyIdTimeouts.set(lobbyId, timeoutId);
    }
    this.lobbyId = null;
    this.lobbyUsers = [];
    this.lobbyHostId = null;
    this.lobbyMetadata = {};
    this.recentMessageIds = [];
  }

  private processPendingLobbyDataUpdates(): void {
    this.sdk.logger.debug("Bulk updating lobby metadata:", this.lobbyMetadata);
    this.sdk.convexClient
      .mutation(api.gameLobby.setLobbyMetadata, {
        lobbyId: this.lobbyId!,
        updates: this.lobbyMetadata,
      })
      .catch((error) => {
        this.sdk.logger.error("Error updating lobby metadata:", error);
      });
  }

  /**
   * Process user updates and emit individual user events
   * @param newUsers - The updated list of lobby users
   */
  private processUserUpdates = (newUsers: LobbyUser[]): void => {
    const previousUsers = this.lobbyUsers;
    const previousUserIds = new Set(previousUsers.map((user) => user.userId));
    const newUserIds = new Set(newUsers.map((user) => user.userId));
    this.lobbyUsers = newUsers;

    // Find users who joined
    for (const user of newUsers) {
      if (user.isHost) {
        this.lobbyHostId = user.userId;
      }
      if (!previousUserIds.has(user.userId)) {
        this.sdk.notifyGame(Signals.LOBBY_USERS_UPDATED, {
          ...user,
          changeType: "JOINED",
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
          isHost: false,
          changeType: "LEFT",
        });
      }
    }

    // Update P2P connections when lobby membership changes
    if (this.lobbyId) {
      this.updateP2PConnections(newUsers);
    }
  };

  private processMessageUpdates = (newMessages: LobbyMessage[]): void => {
    for (const message of newMessages) {
      if (!this.recentMessageIds.includes(message.messageId)) {
        this.recentMessageIds.push(message.messageId);
        this.sdk.notifyGame(Signals.LOBBY_MESSAGE, message);
      }
    }
    this.recentMessageIds = newMessages.map((message) => message.messageId);
  };

  // ================
  // P2P Integration Methods
  // ================

  /**
   * Update P2P connections when lobby membership changes
   * @param newUsers - The updated list of lobby users
   */
  private async updateP2PConnections(newUsers: LobbyUser[]): Promise<void> {
    if (!this.lobbyId) {
      return;
    }

    try {
      if (newUsers.length <= 1) {
        // If only one user left, disconnect all P2P connections
        this.sdk.p2pManager.disconnectP2P();
        this.sdk.logger.debug(
          "Only one user in lobby, P2P connections disconnected"
        );
        return;
      }

      // Convert to WavedashUser format
      const wavedashUsers: WavedashUser[] = newUsers.map((lobbyUser) => ({
        id: lobbyUser.userId,
        username: lobbyUser.username,
      }));

      // Initialize or update P2P - the P2P manager handles both cases
      const result = await this.sdk.p2pManager.initializeP2PForCurrentLobby(
        this.lobbyId,
        wavedashUsers
      );
      if (!result.success) {
        this.sdk.logger.error(
          "Failed to initialize/update P2P connections:",
          result.message
        );
      } else {
        this.sdk.logger.debug(
          `P2P connections updated for lobby ${this.lobbyId} with ${wavedashUsers.length} users`
        );
      }
    } catch (error) {
      this.sdk.logger.error("Error updating P2P connections:", error);
    }
  }
}
