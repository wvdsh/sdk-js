/**
 * Lobby service
 *
 * Implements each of the lobby methods of the Wavedash SDK
 */

import debounce from "lodash.debounce";
import type {
  Id,
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
import { WavedashEvents } from "../events";
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
  private pendingMetadataUpdates: Record<string, string | number | null> = {};
  private recentMessageIds: Id<"lobbyMessages">[] = [];
  private maybeBeingDeletedLobbyIds: Set<Id<"lobbies">> = new Set();
  private resetMaybeBeingDeletedLobbyIdTimeouts: Map<Id<"lobbies">, number> =
    new Map();

  // Cache results of queries for a list of lobbies
  // We'll cache metadata and num users for each lobby and return that info synchronously when requested by the game
  private cachedLobbies: Record<Id<"lobbies">, Lobby> = {};

  // Track lobby invites
  private unsubscribeLobbyInvites: (() => void) | null = null;
  private seenInviteIds: Set<Id<"notifications">> = new Set();

  // Queue for serializing P2P connection updates to prevent race conditions
  private p2pUpdateQueue: Promise<void> = Promise.resolve();

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
  ): Promise<Id<"lobbies">> {
    const result = await this.sdk.convexClient.mutation(
      api.sdk.gameLobby.createAndJoinLobby,
      { visibility, maxPlayers }
    );
    this.handleLobbyJoin(result);
    return result.lobbyId;
  }

  /**
   * Join a lobby
   * @param lobbyId - The ID of the lobby to join
   * @returns true on success. Full lobby context comes via LobbyJoined event.
   * @emits LobbyJoined event on success with full lobby context
   */
  async joinLobby(lobbyId: Id<"lobbies">): Promise<boolean> {
    const result = await this.sdk.convexClient.mutation(
      api.sdk.gameLobby.joinLobby,
      { lobbyId }
    );
    this.handleLobbyJoin(result);
    return true;
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

  getLobbyData(lobbyId: Id<"lobbies">, key: string): string | number | boolean | null {
    if (this.lobbyId === lobbyId) {
      return (this.lobbyMetadata[key] as string | number | boolean) ?? null;
    }
    if (!this.cachedLobbies[lobbyId]) {
      return null;
    }
    return (this.cachedLobbies[lobbyId].metadata[key] as string | number | boolean) ?? null;
  }

  deleteLobbyData(lobbyId: Id<"lobbies">, key: string): boolean {
    return this.setLobbyData(lobbyId, key, null);
  }

  private debouncedMetadataUpdate = debounce(
    () => this.processPendingLobbyDataUpdates(),
    50
  );

  setLobbyData(lobbyId: Id<"lobbies">, key: string, value: string | number | null): boolean {
    if (this.lobbyId !== lobbyId || this.lobbyHostId !== this.sdk.getUserId()) {
      return false;
    }
    if (this.lobbyMetadata[key] === value) return true;

    if (value === null) {
      delete this.lobbyMetadata[key];
    } else {
      this.lobbyMetadata[key] = value;
    }
    this.pendingMetadataUpdates[key] = value;
    this.debouncedMetadataUpdate();
    return true;
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

  async leaveLobby(lobbyId: Id<"lobbies">): Promise<Id<"lobbies">> {
    // Clean up subscriptions BEFORE leaving lobby so we don't trigger updates to ourselves from leaving
    this.cleanupLobbyState();
    await this.sdk.convexClient.mutation(api.sdk.gameLobby.leaveLobby, {
      lobbyId
    });
    this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOBBY_LEFT, {
      lobbyId
    });
    return lobbyId;
  }

  // TODO: Implement more query filters (IP distance, arbitrary key/value matching, etc)
  async listAvailableLobbies(friendsOnly: boolean = false): Promise<Lobby[]> {
    const filters = friendsOnly ? { friendsOnly } : undefined;
    const lobbies = await this.sdk.convexClient.query(
      api.sdk.gameLobby.listAvailable,
      { filters }
    );
    const filteredLobbies = lobbies.filter(
      (lobby) => !this.maybeBeingDeletedLobbyIds.has(lobby.lobbyId)
    );
    for (const lobby of filteredLobbies) {
      this.cachedLobbies[lobby.lobbyId] = lobby;
    }
    return filteredLobbies;
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
  ): Promise<boolean> {
    await this.sdk.convexClient.mutation(api.sdk.gameLobby.inviteToLobby, {
      lobbyId,
      targetUserId: userId
    });
    return true;
  }

  async getLobbyInviteLink(copyToClipboard: boolean = false): Promise<string> {
    if (!this.lobbyId) {
      throw new Error("User is not in a lobby");
    }
    const inviteLink = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.GET_LOBBY_INVITE_LINK,
      { lobbyId: this.lobbyId, copyToClipboard }
    );
    if (!inviteLink) {
      throw new Error("Parent could not generate invite link");
    }
    return inviteLink;
  }

  // ================
  // Private Methods
  // ================

  /**
   * Initialize local lobby state and subscribe to all relevant updates.
   * Sets up Convex subscriptions for messages, users, and metadata.
   * Emits LobbyJoined event to the game engine.
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

    // Cache initial lobby users for avatar lookups
    this.sdk.friendsManager.cacheUsers(response.users);

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
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.LOBBY_DATA_UPDATED,
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

    // Initialize P2P connections immediately with the users from join response
    // Don't wait for the subscription callback - we already have the user list
    // This prevents race conditions where signaling messages arrive before P2P is set up
    if (response.users.length > 1) {
      this.p2pUpdateQueue = this.updateP2PConnections(response.users).catch(
        (error) => {
          this.sdk.logger.error("Error initializing P2P on join:", error);
        }
      );
    }

    // Notify parent iframe
    this.sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.LOBBY_JOINED, {
      lobbyId: response.lobbyId
    });

    this.sdk.gameEventManager.notifyGame(WavedashEvents.LOBBY_JOINED, {
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
   * Multiple subscriptions may error at once, so we guard against emitting multiple events
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

    // Emit LOBBY_KICKED event
    this.sdk.gameEventManager.notifyGame(WavedashEvents.LOBBY_KICKED, {
      lobbyId,
      reason
    } satisfies LobbyKickedPayload);
  }

  /**
   * Clean up lobby state without emitting events
   * Used internally by handleLobbyJoin() and handleLobbyKicked()
   */
  private cleanupLobbyState(): void {
    // Capture lobbyId before clearing (used for "maybe being deleted" tracking)
    const currentLobbyId = this.lobbyId;

    // Set lobbyId to null immediately to guard against multiple calls (e.g., from concurrent subscription errors)
    this.lobbyId = null;

    this.debouncedMetadataUpdate.cancel();
    this.pendingMetadataUpdates = {};

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

    // Reset the P2P update queue to prevent stale operations
    this.p2pUpdateQueue = Promise.resolve();
  }

  /**
   * Public method to clean up lobby state without emitting events
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
    const updates = this.pendingMetadataUpdates;
    this.pendingMetadataUpdates = {};
    this.sdk.convexClient
      .mutation(api.sdk.gameLobby.setLobbyMetadata, {
        lobbyId: this.lobbyId!,
        updates
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
    // Cache users for avatar lookups
    this.sdk.friendsManager.cacheUsers(newUsers);

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
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.LOBBY_USERS_UPDATED,
          {
            ...user,
            changeType: LobbyUserChangeType.JOINED
          } satisfies LobbyUsersUpdatedPayload
        );
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
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.LOBBY_USERS_UPDATED,
          {
            ...user,
            isHost: false,
            changeType: LobbyUserChangeType.LEFT
          } satisfies LobbyUsersUpdatedPayload
        );
      }
    }

    // Update P2P connections when lobby membership changes
    // Serialize P2P updates to prevent race conditions from concurrent subscription callbacks
    if (this.lobbyId) {
      this.p2pUpdateQueue = this.p2pUpdateQueue
        .then(() => this.updateP2PConnections(newUsers))
        .catch((error) => {
          this.sdk.logger.error("Error in queued P2P update:", error);
        });
    }
  };

  private processMessageUpdates = (newMessages: LobbyMessage[]): void => {
    for (const message of newMessages) {
      if (!this.recentMessageIds.includes(message.messageId)) {
        this.recentMessageIds.push(message.messageId);
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.LOBBY_MESSAGE,
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
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.LOBBY_INVITE,
          invite satisfies LobbyInvitePayload
        );
      }
    }
    // Update seen IDs to match current invites (remove stale ones)
    this.seenInviteIds = new Set(
      invites.map((invite) => invite.notificationId)
    );
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
      const wavedashUsers: SDKUser[] = newUsers.map((lobbyUser: LobbyUser) => ({
        id: lobbyUser.userId,
        username: lobbyUser.username,
        avatarUrl: lobbyUser.userAvatarUrl
      }));

      await this.sdk.p2pManager.initializeP2PForCurrentLobby(
        this.lobbyId,
        wavedashUsers
      );
      this.sdk.logger.debug(
        `P2P connections updated for lobby ${this.lobbyId} with ${wavedashUsers.length} users`
      );
    } catch (error) {
      this.sdk.logger.error("Error updating P2P connections:", error);
    }
  }
}
