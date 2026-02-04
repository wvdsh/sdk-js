import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";

import { Signals } from "./signals";
import { api, GAME_ENGINE, PublicApiType } from "@wvdsh/types";

// Extract types from the API
export type LobbyVisibility =
  PublicApiType["sdk"]["gameLobby"]["createAndJoinLobby"]["_args"]["visibility"];
export type LobbyUser = FunctionReturnType<
  typeof api.sdk.gameLobby.lobbyUsers
>[0];
export type LobbyMessage = FunctionReturnType<
  typeof api.sdk.gameLobby.lobbyMessages
>[0];
export type Lobby = FunctionReturnType<
  typeof api.sdk.gameLobby.listAvailable
>[0];
export type LobbyJoinResponse = FunctionReturnType<
  typeof api.sdk.gameLobby.joinLobby
>;
export type LobbyInvite = FunctionReturnType<
  typeof api.sdk.gameLobby.getLobbyInvites
>[0];
export type UGCType =
  PublicApiType["sdk"]["userGeneratedContent"]["createUGCItem"]["_args"]["ugcType"];
export type UGCVisibility =
  PublicApiType["sdk"]["userGeneratedContent"]["createUGCItem"]["_args"]["visibility"];
export type LeaderboardSortOrder =
  PublicApiType["sdk"]["leaderboards"]["getOrCreateLeaderboard"]["_args"]["sortOrder"];
export type LeaderboardDisplayType =
  PublicApiType["sdk"]["leaderboards"]["getOrCreateLeaderboard"]["_args"]["displayType"];
export type Leaderboard = FunctionReturnType<
  typeof api.sdk.leaderboards.getLeaderboard
>;
export type LeaderboardEntries = FunctionReturnType<
  typeof api.sdk.leaderboards.listEntriesAroundUser
>["entries"];
export type UpsertedLeaderboardEntry = FunctionReturnType<
  typeof api.sdk.leaderboards.upsertLeaderboardEntry
>["entry"] & {
  userId: Id<"users">;
  username: string;
};

export type P2PTurnCredentials = FunctionReturnType<
  typeof api.sdk.turnCredentials.getOrCreate
>;

export type P2PSignalingMessage = Omit<
  FunctionReturnType<typeof api.sdk.p2pSignaling.getSignalingMessages>[0],
  "data"
> & {
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

// Type helper to get signal values as a union type
export type Signal = (typeof Signals)[keyof typeof Signals];

// Configuration and user types
export interface WavedashConfig {
  gameId: Id<"games">;
  debug?: boolean;
  remoteStorageOrigin?: string;
  p2p?: Partial<P2PConfig>;
  disableAchievementsAndStats?: boolean; // true for demo games so we don't fill up achievements and stats with live demo data
  deferEvents?: boolean; // if true wait until game calls readyForEvents to start sending Signal event messages to game
}

export interface RemoteFileMetadata {
  exists: boolean; // Whether the entry exists
  key: string; // R2 Key of the entry
  name: string; // Name of the entry relative to the requested directory path
  lastModified: number; // Last modified timestamp of the entry (ISO format)
  size: number; // Size of the entry in bytes
  etag: string; // ETag of the entry
}

export interface EngineInstance {
  // Add more as we support more engines
  type: (typeof GAME_ENGINE)[keyof typeof GAME_ENGINE];
  // Broadcasts a message to the engine instance
  // Exposed natively by Unity's engine instance, added manually by Wavedash Godot SDK
  SendMessage(
    objectName: string,
    methodName: Signal,
    value?: string | number | boolean
  ): void;
  // Standard Emscripten filesystem API: https://emscripten.org/docs/api_reference/Filesystem-API.html
  FS: {
    readFile(path: string, opts?: Record<string, unknown>): string | Uint8Array;
    writeFile(
      path: string,
      data: string | ArrayBufferView,
      opts?: Record<string, unknown>
    ): void;
    mkdirTree(path: string, mode?: number): void;
    syncfs(populate: boolean, callback?: (err: unknown) => void): void;
    analyzePath(path: string): { exists: boolean };
    // ... other functions
  };
  // ... other internal properties and methods
}

// Response types
export interface WavedashResponse<T> {
  success: boolean;
  data: T | null;
  // Return the original args that were passed to the JS SDK so caller can reference them
  // TODO: Caller shouldn't rely on this, remove this field
  args: Record<string, unknown>;
  // Error message if success is false
  message?: string;
  // TODO: errorCode?
}

// =============================================================================
// Signal Payloads
// These are the payload types for each signal that the SDK emits to the game engine.
// =============================================================================

// --- Lobby Signals ---

/** Payload for LOBBY_JOINED signal - emitted on lobby join attempt (success or failure), as well successful lobby create */
export interface LobbyJoinedPayload {
  success: boolean;
  lobbyId: Id<"lobbies">;
  // Present on success
  hostId?: Id<"users">;
  users?: LobbyUser[];
  metadata?: Record<string, unknown>;
  // Present on failure
  message?: string;
}

/** Reasons why a user was kicked from a lobby */
export const LobbyKickedReason = {
  KICKED: "KICKED",
  ERROR: "ERROR"
} as const;
export type LobbyKickedReason =
  (typeof LobbyKickedReason)[keyof typeof LobbyKickedReason];

/** Payload for LOBBY_KICKED signal - emitted when removed from a lobby */
export interface LobbyKickedPayload {
  lobbyId: Id<"lobbies">;
  reason: LobbyKickedReason;
}

/** Change types for lobby user updates */
export const LobbyUserChangeType = {
  JOINED: "JOINED",
  LEFT: "LEFT"
} as const;
export type LobbyUserChangeType =
  (typeof LobbyUserChangeType)[keyof typeof LobbyUserChangeType];

/** Payload for LOBBY_USERS_UPDATED signal - emitted when a user joins or leaves */
export interface LobbyUsersUpdatedPayload extends LobbyUser {
  changeType: LobbyUserChangeType;
}

/** Payload for LOBBY_DATA_UPDATED signal - the full lobby metadata */
export type LobbyDataUpdatedPayload = Record<string, unknown>;

/** Payload for LOBBY_MESSAGE signal - a message received in the lobby */
export type LobbyMessagePayload = LobbyMessage;

/** Payload for LOBBY_INVITE signal - an invite to join a lobby */
export type LobbyInvitePayload = LobbyInvite;

// --- P2P Signals ---

/** Payload for P2P_CONNECTION_ESTABLISHED signal */
export interface P2PConnectionEstablishedPayload {
  userId: Id<"users">;
  username: string;
}

/** Payload for P2P_CONNECTION_FAILED signal */
export interface P2PConnectionFailedPayload {
  userId: Id<"users">;
  username: string;
  error: string;
}

/** Payload for P2P_PEER_DISCONNECTED signal */
export interface P2PPeerDisconnectedPayload {
  userId: Id<"users">;
  username: string;
}

// --- Backend Connection Signals ---

/** Payload for BACKEND_CONNECTED, BACKEND_DISCONNECTED, BACKEND_RECONNECTING signals */
export interface BackendConnectionPayload {
  isConnected: boolean;
  hasEverConnected: boolean;
  connectionCount: number;
  connectionRetries: number;
}

// =============================================================================
// P2P Connection types
// =============================================================================
export interface P2PPeer {
  userId: Id<"users">; // Primary identifier - links to persistent user
  username: string;
  // TODO Calvin: Consider adding int handle for each peer to speed up messaging over string handles
}

export interface P2PConnection {
  lobbyId: Id<"lobbies">;
  peers: Record<Id<"users">, P2PPeer>; // userId -> peer info (we may add more fields to P2PPeer later)
  state: P2PConnectionState;
}

export type P2PConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";

export interface P2PMessage {
  fromUserId: Id<"users">; // Primary identifier for sender TODO: Make this a small int handle instead of a 32 byte string
  channel: number; // Channel for message routing
  payload: Uint8Array;
  // TODO: Assign an incrementing messsage ID to each message for ordering?
}

// P2P Configuration
export interface P2PConfig {
  maxPeers: number;
  enableReliableChannel: boolean;
  enableUnreliableChannel: boolean;
}

// Re-export Id for convenience
export type { Id };
