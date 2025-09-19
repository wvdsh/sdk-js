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
} from '../types';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';

// Assuming we only have one WavedashSDK instance at a time, we can use a global variable to store the unsubscribe function
let unsubscribeLobbyMessages: (() => void) | null = null;
let unsubscribeLobbyUsers: (() => void) | null = null;
let unsubscribeLobbyData: (() => void) | null = null;

export async function createLobby(this: WavedashSDK, lobbyType: LobbyType, maxPlayers?: number): Promise<WavedashResponse<Id<"lobbies">>> {
  const args = {
    lobbyType: lobbyType,
    maxPlayers: maxPlayers
  };

  try {
    const lobbyId = await this.convexClient.mutation(
      api.gameLobby.createAndJoinLobby,
      args
    );

    subscribeToLobbyUpdates.call(this, lobbyId);

    return {
      success: true,
      data: lobbyId,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error creating lobby: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function joinLobby(this: WavedashSDK, lobbyId: Id<"lobbies">): Promise<WavedashResponse<Id<"lobbies">>> {
  const args = { lobbyId };

  try {
    const success = await this.convexClient.mutation(
      api.gameLobby.joinLobby,
      args
    );

    if (!success) {
      throw new Error(`Failed to join lobby: ${lobbyId}`);
    }

    // Subscribe to lobby messages
    subscribeToLobbyUpdates.call(this, lobbyId);

    return {
      success: true,
      data: lobbyId,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error joining lobby: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getLobbyUsers(this: WavedashSDK, lobbyId: Id<"lobbies">): Promise<WavedashResponse<LobbyUsers>> {
  const args = { lobbyId };
  try{
    const users = await this.convexClient.query(
      api.gameLobby.lobbyUsers,
      args
    );
    return {
      success: true,
      data: users,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error getting lobby users: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function leaveLobby(this: WavedashSDK, lobbyId: Id<"lobbies">): Promise<WavedashResponse<boolean>> {
  const args = { lobbyId };

  try {
    await this.convexClient.mutation(
      api.gameLobby.leaveLobby,
      args
    );

    // Clean up subscription
    unsubscribeFromCurrentLobbyUpdates();

    return {
      success: true,
      data: true,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error leaving lobby: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function sendLobbyMessage(this: WavedashSDK, lobbyId: Id<"lobbies">, message: string): Promise<WavedashResponse<boolean>> {
  const args = { lobbyId, message };

  try {
    await this.convexClient.mutation(
      api.gameLobby.sendMessage,
      args
    );

    return {
      success: true,
      data: true,
      args: args
    };
  } catch (error) {
    this.logger.error(`Error sending lobby message: ${error}`);
    return {
      success: false,
      data: null,
      args: args,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

// =============================
// JS -> Game Event Broadcasting
// =============================

function notifyLobbyJoined(this: WavedashSDK, lobbyData: object): void {
  this.engineInstance?.SendMessage(
    this.engineCallbackReceiver,
    'LobbyJoined',
    JSON.stringify(lobbyData)
  );
}

function notifyLobbyLeft(this: WavedashSDK, lobbyData: object): void {
  this.engineInstance?.SendMessage(
    this.engineCallbackReceiver,
    'LobbyLeft',
    JSON.stringify(lobbyData)
  );
}

function notifyLobbyMessage(this: WavedashSDK, payload: object): void {
  this.engineInstance?.SendMessage(
    this.engineCallbackReceiver,
    'LobbyMessage',
    JSON.stringify(payload)
  );
}

function notifyLobbyUserUpdate(this: WavedashSDK, payload: object): void {
  this.engineInstance?.SendMessage(
    this.engineCallbackReceiver,
    'LobbyUserUpdate',
    JSON.stringify(payload)
  );
}

function subscribeToLobbyUpdates(this: WavedashSDK, lobbyId: Id<"lobbies">): void {
  // Unsubscribe from previous lobby if any
  unsubscribeFromCurrentLobbyUpdates();

  // Subscribe to lobby messages
  const unsubscribeMessages = this.convexClient.onUpdate(
    api.gameLobby.lobbyMessages,
    {
      lobbyId: lobbyId
    },
    (messages: any) => {
      this.logger.info('Lobby messages updated:', messages);
      // Notify the game about new messages
      if (messages && messages.length > 0) {
        notifyLobbyMessage.call(this, {
          id: lobbyId,
          messages: messages
        });
      }
    }
  );

  // Subscribe to lobby users
  const unsubscribeUsers = this.convexClient.onUpdate(
    api.gameLobby.lobbyUsers,
    {
      lobbyId: lobbyId
    },
    (users: any) => {
      this.logger.info('Lobby users updated:', users);
      // Notify the game about new users
      if (users && users.length > 0) {
        notifyLobbyUserUpdate.call(this, {
          id: lobbyId,
          users: users
        });
      }
    }
  );

  // Store the unsubscribe function
  unsubscribeLobbyMessages = unsubscribeMessages;

  this.logger.debug('Subscribed to lobby messages for:', lobbyId);
}

function unsubscribeFromCurrentLobbyUpdates(): void {
  if (unsubscribeLobbyMessages) {
    unsubscribeLobbyMessages();
    unsubscribeLobbyMessages = null;
  }
  if (unsubscribeLobbyUsers) {
    unsubscribeLobbyUsers();
    unsubscribeLobbyUsers = null;
  }
  if (unsubscribeLobbyData) {
    unsubscribeLobbyData();
    unsubscribeLobbyData = null;
  }
}