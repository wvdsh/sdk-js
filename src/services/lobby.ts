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
  LobbyInvite,
  LobbyJoinedPayload,
  LobbyKickedPayload,
  LobbyUsersUpdatedPayload,
  LobbyDataUpdatedPayload,
  LobbyMessagePayload,
  LobbyInvitePayload,
  LobbyJoinResponse
} from "../types";
import { LobbyKickedReason, LobbyUserChangeType } from "../types";
import { Signals } from "../signals";
import type { WavedashSDK } from "../index";
import {
  api,
  IFRAME_MESSAGE_TYPE,
  LOBBY_MESSAGE_MAX_LENGTH,
  SDKUser
} from "@wvdsh/types";

export class LobbyManager {
  private sdk: WavedashSDK;

  // Track current lobby state
  private unsubscribeLobbyMessages: (() => void) | null = null;
  private unsubscribeLobbyUsers: (() => void) | null = null;
  private unsubscribeLobbyData: (() => void) | null = null;
  private lobbyId: Id<"lobbies"> | null = null;
  private lobbyUsers: LobbyUser[] = [];
  private lobbyHostId: Id<"users"> | null = null;
  private lobbyMetadata: Record<string, unknown> = {};
  private recentMessageIds: Id<"lobbyMessages">[] = [];
  private lobbyDataUpdateTimeout: number | null = null;
  private maybeBeingDeletedLobbyIds: Set<Id<"lobbies">> = new Set();
  private resetMaybeBeingDeletedLobbyIdTimeouts: Map<Id<"lobbies">, number> =
    new Map();

  // Cache results of queries for a list of lobbies
  // We'll cache metadata and num users for each lobby and return that info synchronously when requested by the game
  private cachedLobbies: Record<Id<"lobbies">, Lobby> = {};

  // Track lobby invites
  private unsubscribeLobbyInvites: (() => void) | null = null;
  private seenInviteIds: Set<Id<"notifications">> = new Set();

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  // ================
  // Public Methods
  // ================

  /**
   * Initialize the lobby manager.
   * Called during SDK initialization.
   */
  init(): void {
    if (this.unsubscribeLobbyInvites) {
      return; // Already listening
    }

    this.unsubscribeLobbyInvites = this.sdk.convexClient.onUpdate(
      api.sdk.gameLobby.getLobbyInvites,
      {},
      this.processInviteUpdates,
      (error) => {
        this.sdk.logger.error(`Lobby invites subscription error: ${error}`);
      }
    );

    this.sdk.logger.debug("Started listening for lobby invites");
  }

  async createLobby(
    visibility: LobbyVisibility,
    maxPlayers?: number
  ): Promise<WavedashResponse<Id<"lobbies">>> {
    const args = { visibility, maxPlayers };

    try {
      // Cast through unknown until Convex types are regenerated
      const result = await this.sdk.convexClient.mutation(
        api.sdk.gameLobby.createAndJoinLobby,
        args
      );

      this.handleLobbyJoin(result);

      return {
        success: true,
        data: result.lobbyId,
        args
      };
    } catch (error) {
      this.sdk.logger.error(`Error creating lobby: ${error}`);
      return {
        success: false,
        data: null,
        args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Join a lobby
   * @param lobbyId - The ID of the lobby to join
   * @returns A WavedashResponse with success/failure. Full lobby context comes via LOBBY_JOINED signal.
   * @emits LOBBY_JOINED signal to the game engine with full lobby context
   */
  async joinLobby(lobbyId: Id<"lobbies">): Promise<WavedashResponse<boolean>> {
    const args = { lobbyId };

    try {
      // Cast through unknown until Convex types are regenerated
      const result = await this.sdk.convexClient.mutation(
        api.sdk.gameLobby.joinLobby,
        args
      );

      this.handleLobbyJoin(result);

      return {
        success: true,
        data: true,
        args
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sdk.logger.error(`Error joining lobby: ${message}`);

      // Emit LOBBY_JOINED signal with failure so all SDKs receive consistent shape
      this.sdk.notifyGame(Signals.LOBBY_JOINED, {
        success: false,
        lobbyId,
        message
      } satisfies LobbyJoinedPayload);

      return {
        success: false,
        data: false,
        args,
        message
      };
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

  getLobbyData(lobbyId: Id<"lobbies">, key: string): unknown {
    // Current lobby has a subscription, so we can get the data directly
    if (this.lobbyId === lobbyId) {
      return this.lobbyMetadata[key] ?? "";
    }
    // Otherwise return the latest cached data from listed lobbies
    if (!this.cachedLobbies[lobbyId]) {
      return "";
    }
    return this.cachedLobbies[lobbyId].metadata[key] ?? "";
  }

  // Set synchronously here and batch updates to the backend in a single request
  // That way game can easily set all the data it needs in sequential calls without multiple network requests
  setLobbyData(lobbyId: Id<"lobbies">, key: string, value: unknown): boolean {
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
      this.cleanupLobbyState();

      // Now we can leave the lobby
      await this.sdk.convexClient.mutation(api.sdk.gameLobby.leaveLobby, args);

      this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOBBY_LEFT, {
        lobbyId
      });

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

  async listAvailableLobbies(
    friendsOnly: boolean = false
  ): Promise<WavedashResponse<Lobby[]>> {
    // TODO: Implement more query filters (IP distance, arbitrary key/value matching, etc)
    const args = { friendsOnly };
    const filters = friendsOnly ? { friendsOnly } : undefined;
    try {
      const lobbies = await this.sdk.convexClient.query(
        api.sdk.gameLobby.listAvailable,
        { filters }
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
      this.sdk.convexClient.mutation(api.sdk.gameLobby.sendMessage, args);
    } catch (error) {
      this.sdk.logger.error(`Error sending lobby message: ${error}`);
      return false;
    }

    return true;
  }

  async inviteUserToLobby(
    lobbyId: Id<"lobbies">,
    userId: Id<"users">
  ): Promise<WavedashResponse<boolean>> {
    const args = { lobbyId, targetUserId: userId };

    try {
      await this.sdk.convexClient.mutation(
        api.sdk.gameLobby.inviteToLobby,
        args
      );

      return {
        success: true,
        data: true,
        args
      };
    } catch (error) {
      this.sdk.logger.error(`Error inviting user to lobby: ${error}`);
      return {
        success: false,
        data: false,
        args,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // ================
  // Private Methods
  // ================

  /**
   * Initialize local lobby state and subscribe to all relevant updates.
   * Sets up Convex subscriptions for messages, users, and metadata.
   * Emits LOBBY_JOINED signal to the game engine.
   * @precondition - The user has already joined the lobby via mutation
   * @param response - The full response from createAndJoinLobby or joinLobby mutation
   */
  private handleLobbyJoin(response: LobbyJoinResponse): void {
    // Unsubscribe from previous lobby if any
    this.cleanupLobbyState();

    // Initialize local state from response
    this.lobbyId = response.lobbyId;
    this.lobbyHostId = response.hostId;
    this.lobbyUsers = response.users;
    this.lobbyMetadata = response.metadata;

    // Error handler for subscription failures (e.g., kicked from lobby)
    const onLobbySubscriptionError = (error: Error) => {
      this.sdk.logger.error(`Lobby subscription error: ${error.message}`);
      // Check if this is a "not a member" error indicating we were kicked
      if (error.message.includes("not a member")) {
        this.handleLobbyKicked(LobbyKickedReason.KICKED);
      } else {
        this.handleLobbyKicked(LobbyKickedReason.ERROR);
      }
    };

    // Subscribe to lobby messages
    this.unsubscribeLobbyMessages = this.sdk.convexClient.onUpdate(
      api.sdk.gameLobby.lobbyMessages,
      { lobbyId: response.lobbyId },
      this.processMessageUpdates,
      onLobbySubscriptionError
    );

    // Subscribe to lobby metadata
    this.unsubscribeLobbyData = this.sdk.convexClient.onUpdate(
      api.sdk.gameLobby.getLobbyMetadata,
      { lobbyId: response.lobbyId },
      (lobbyMetadata: Record<string, unknown>) => {
        this.lobbyMetadata = lobbyMetadata;
        this.sdk.notifyGame(
          Signals.LOBBY_DATA_UPDATED,
          lobbyMetadata satisfies LobbyDataUpdatedPayload
        );
      },
      onLobbySubscriptionError
    );

    // Subscribe to lobby users
    this.unsubscribeLobbyUsers = this.sdk.convexClient.onUpdate(
      api.sdk.gameLobby.lobbyUsers,
      { lobbyId: response.lobbyId },
      this.processUserUpdates,
      onLobbySubscriptionError
    );

    // Notify parent iframe
    this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOBBY_JOINED, {
      lobbyId: response.lobbyId
    });

    // Emit LOBBY_JOINED signal with full lobby context
    this.sdk.notifyGame(Signals.LOBBY_JOINED, {
      success: true,
      lobbyId: response.lobbyId,
      hostId: response.hostId,
      users: response.users,
      metadata: response.metadata
    } satisfies LobbyJoinedPayload);

    this.sdk.logger.debug("Subscribed to lobby:", response.lobbyId);
  }

  /**
   * Handle being kicked or removed from a lobby (subscription error)
   * This is called when a subscription fails with "User is not a member of this lobby"
   * Multiple subscriptions may error at once, so we guard against emitting multiple signals
   */
  private handleLobbyKicked(
    reason: LobbyKickedReason = LobbyKickedReason.KICKED
  ): void {
    const lobbyId = this.lobbyId;
    if (!lobbyId) return;

    this.sdk.logger.warn(
      `User was removed from lobby: ${lobbyId} (reason: ${reason})`
    );
    this.cleanupLobbyState();

    this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOBBY_LEFT, {
      lobbyId
    });

    // Emit LOBBY_KICKED signal
    this.sdk.notifyGame(Signals.LOBBY_KICKED, {
      lobbyId,
      reason
    } satisfies LobbyKickedPayload);
  }

  /**
   * Clean up lobby state without emitting signals
   * Used internally by handleLobbyJoin() and handleLobbyKicked()
   */
  private cleanupLobbyState(): void {
    // Capture lobbyId before clearing (used for "maybe being deleted" tracking)
    const currentLobbyId = this.lobbyId;

    // Set lobbyId to null immediately to guard against multiple calls (e.g., from concurrent subscription errors)
    this.lobbyId = null;

    // Clear pending lobby data update timeout
    if (this.lobbyDataUpdateTimeout) {
      clearTimeout(this.lobbyDataUpdateTimeout);
      this.lobbyDataUpdateTimeout = null;
    }

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
    if (currentLobbyId && this.lobbyUsers.length === 1) {
      // Clear any existing timeout for this lobby
      const existingTimeout =
        this.resetMaybeBeingDeletedLobbyIdTimeouts.get(currentLobbyId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Track this lobby as potentially being deleted
      this.maybeBeingDeletedLobbyIds.add(currentLobbyId);

      // Set timeout to remove it from the set after 500ms
      const timeoutId = setTimeout(() => {
        this.maybeBeingDeletedLobbyIds.delete(currentLobbyId);
        this.resetMaybeBeingDeletedLobbyIdTimeouts.delete(currentLobbyId);
      }, 500);

      this.resetMaybeBeingDeletedLobbyIdTimeouts.set(currentLobbyId, timeoutId);
    }

    this.lobbyUsers = [];
    this.lobbyHostId = null;
    this.lobbyMetadata = {};
    this.recentMessageIds = [];
  }

  /**
   * Public method to clean up lobby state without emitting signals
   * Used for session end cleanup
   */
  unsubscribeFromCurrentLobby(): void {
    this.cleanupLobbyState();
  }

  /**
   * Fully destroy the LobbyManager, cleaning up all subscriptions and timeouts.
   * Called during session end to ensure no lingering listeners.
   */
  destroy(): void {
    // Clean up current lobby state (messages, users, data subscriptions, P2P)
    this.cleanupLobbyState();

    // Clean up lobby invites subscription
    if (this.unsubscribeLobbyInvites) {
      this.unsubscribeLobbyInvites();
      this.unsubscribeLobbyInvites = null;
    }

    // Clear all "maybe being deleted" tracking timeouts
    for (const timeoutId of this.resetMaybeBeingDeletedLobbyIdTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    this.resetMaybeBeingDeletedLobbyIdTimeouts.clear();
    this.maybeBeingDeletedLobbyIds.clear();

    // Clear other state
    this.seenInviteIds.clear();
    this.cachedLobbies = {};
  }

  private processPendingLobbyDataUpdates(): void {
    this.sdk.logger.debug("Bulk updating lobby metadata:", this.lobbyMetadata);
    this.sdk.convexClient
      .mutation(api.sdk.gameLobby.setLobbyMetadata, {
        lobbyId: this.lobbyId!,
        updates: this.lobbyMetadata
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
          changeType: LobbyUserChangeType.JOINED
        } satisfies LobbyUsersUpdatedPayload);
      }
    }

    // Find users who left
    for (const user of previousUsers) {
      if (!newUserIds.has(user.userId)) {
        if (user.userId === this.sdk.getUserId()) {
          this.sdk.logger.warn(
            "USER WAS KICKED FROM LOBBY! Received notification for myself leaving."
          );
        }
        // For now, we can't distinguish between LEFT, DISCONNECTED, or KICKED
        // from the basic lobby users update. Default to LEFT.
        this.sdk.notifyGame(Signals.LOBBY_USERS_UPDATED, {
          ...user,
          isHost: false,
          changeType: LobbyUserChangeType.LEFT
        } satisfies LobbyUsersUpdatedPayload);
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
        this.sdk.notifyGame(
          Signals.LOBBY_MESSAGE,
          message satisfies LobbyMessagePayload
        );
      }
    }
    this.recentMessageIds = newMessages.map((message) => message.messageId);
  };

  private processInviteUpdates = (invites: LobbyInvite[]): void => {
    for (const invite of invites) {
      if (!this.seenInviteIds.has(invite.notificationId)) {
        this.seenInviteIds.add(invite.notificationId);
        this.sdk.notifyGame(
          Signals.LOBBY_INVITE,
          invite satisfies LobbyInvitePayload
        );
      }
    }
    // Update seen IDs to match current invites (remove stale ones)
    this.seenInviteIds = new Set(invites.map((invite) => invite.notificationId));
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
      const wavedashUsers: SDKUser[] = newUsers.map((lobbyUser) => ({
        id: lobbyUser.userId,
        username: lobbyUser.username
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
