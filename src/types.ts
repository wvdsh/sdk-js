/**
 * Public types exported from @wvdsh/sdk-js
 */

import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";

import { WavedashEvents } from "./events";
import { api } from "@wvdsh/api";
import {
  LobbyKickedReason as LobbyKickedReasonConst,
  LobbyUserChangeType as LobbyUserChangeTypeConst,
  P2PPacketDropReason as P2PPacketDropReasonConst,
  LOBBY_VISIBILITY,
  LEADERBOARD_SORT_ORDER,
  LEADERBOARD_DISPLAY_TYPE,
  UGC_TYPE,
  UGC_VISIBILITY,
  GAME_ENGINE
} from "./constants";

// Type unions derived from the SDK's runtime constants.
export type LobbyVisibility =
  (typeof LOBBY_VISIBILITY)[keyof typeof LOBBY_VISIBILITY];
export type LeaderboardSortOrder =
  (typeof LEADERBOARD_SORT_ORDER)[keyof typeof LEADERBOARD_SORT_ORDER];
export type LeaderboardDisplayType =
  (typeof LEADERBOARD_DISPLAY_TYPE)[keyof typeof LEADERBOARD_DISPLAY_TYPE];
export type UGCType = (typeof UGC_TYPE)[keyof typeof UGC_TYPE];
export type UGCVisibility =
  (typeof UGC_VISIBILITY)[keyof typeof UGC_VISIBILITY];

// Function return type aliases derived from the API
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
export type Friend = FunctionReturnType<typeof api.sdk.friends.listFriends>[0];
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

// Type helper to get event values as a union type
export type WavedashEvent =
  (typeof WavedashEvents)[keyof typeof WavedashEvents];

// Configuration and user types
export interface WavedashConfig {
  debug?: boolean;
  remoteStorageOrigin?: string;
  p2p?: Partial<P2PConfig>;
  deferEvents?: boolean;
}

// URL query params that were present when the game was launched
export type { GameLaunchParams } from "@wvdsh/api";

export interface RemoteFileMetadata {
  exists: boolean; // Whether the entry exists
  key: string; // Absolute file path of the entry, this is the path downloadRemoteDirectory will download to (ex: /idbfs/<hash>/save.dat)
  name: string; // Name of the entry relative to the requested directory path (ex: save.dat)
  lastModified: number; // Last modified timestamp of the entry (ISO format)
  size: number; // Size of the entry in bytes
  etag: string; // ETag of the entry
}

export interface EngineInstance {
  type: (typeof GAME_ENGINE)[keyof typeof GAME_ENGINE];
  // Broadcasts a message to the engine instance
  // Exposed natively by Unity's engine instance, added manually by Wavedash Godot SDK
  SendMessage(
    objectName: string,
    methodName: WavedashEvent,
    value?: string | number
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
  // Unity specific property, should be set to Application.persistentDataPath
  unityPersistentDataPath?: string;
  // ... other internal properties and methods
}

// Response types
export type WavedashResponse<T> =
  | { success: true; data: T }
  | { success: false; data: null; message: string };

// =============================================================================
// Event Payloads
// These are the payload types for each event that the SDK emits to the game engine.
// =============================================================================

// --- Lobby Events ---

/** Payload for LobbyJoined event - emitted on successful lobby join or create */
export interface LobbyJoinedPayload {
  lobbyId: Id<"lobbies">;
  hostId: Id<"users">;
  users: LobbyUser[];
  metadata: Record<string, unknown>;
}

export type LobbyKickedReason =
  (typeof LobbyKickedReasonConst)[keyof typeof LobbyKickedReasonConst];

/** Payload for LobbyKicked event - emitted when removed from a lobby */
export interface LobbyKickedPayload {
  lobbyId: Id<"lobbies">;
  reason: LobbyKickedReason;
}

export type LobbyUserChangeType =
  (typeof LobbyUserChangeTypeConst)[keyof typeof LobbyUserChangeTypeConst];

/** Payload for LobbyUsersUpdated event - emitted when a user joins or leaves */
export interface LobbyUsersUpdatedPayload extends LobbyUser {
  changeType: LobbyUserChangeType;
}

/** Payload for LobbyDataUpdated event - the full lobby metadata */
export type LobbyDataUpdatedPayload = Record<string, unknown>;

/** Payload for LobbyMessage event - a message received in the lobby */
export type LobbyMessagePayload = LobbyMessage;

/** Payload for LobbyInvite event - an invite to join a lobby */
export type LobbyInvitePayload = LobbyInvite;

// --- Stats & Achievements Events ---

/** Payload for StatsStored event - emitted when stats/achievements are persisted */
export interface StatsStoredPayload {
  success: boolean;
  message?: string;
}

// --- P2P Events ---

/** Payload for P2PConnectionEstablished event */
export interface P2PConnectionEstablishedPayload {
  userId: Id<"users">;
  username: string;
}

/** Payload for P2PConnectionFailed event */
export interface P2PConnectionFailedPayload {
  userId: Id<"users">;
  username: string;
  error: string;
}

/** Payload for P2PPeerDisconnected event */
export interface P2PPeerDisconnectedPayload {
  userId: Id<"users">;
  username: string;
}

/** Payload for P2PPeerReconnecting event */
export interface P2PPeerReconnectingPayload {
  userId: Id<"users">;
  username: string;
}

/** Payload for P2PPeerReconnected event */
export interface P2PPeerReconnectedPayload {
  userId: Id<"users">;
  username: string;
}

export type P2PPacketDropReason =
  (typeof P2PPacketDropReasonConst)[keyof typeof P2PPacketDropReasonConst];

/**
 * Payload for P2PPacketDropped event.
 *
 * Emitted whenever the SDK drops a P2P packet — either outgoing (rejected
 * by local validation) or incoming (rejected by the receive-side ring
 * buffer / framing layer).
 *
 * Events are aggregated per `(channel, direction, reason)` tuple with a
 * short window so bursty drops don't flood the game, while sparse drops
 * still fire promptly.
 */
export interface P2PPacketDroppedPayload {
  channel: number; // app channel; -1 if not determinable (malformed wire data or invalid send-side channel)
  direction: "SEND" | "RECEIVE";
  reason: P2PPacketDropReason;
  droppedCount: number; // Number of drops coalesced into this event
  droppedTotal: number; // Cumulative number of drops since the P2PManager was initialized
}

// --- Backend Connection Events ---

/** Payload for BackendConnected, BackendDisconnected, BackendReconnecting events */
export interface BackendConnectionPayload {
  isConnected: boolean;
  hasEverConnected: boolean;
  connectionCount: number;
  connectionRetries: number;
}

// --- Fullscreen Events ---

/** Payload for FullscreenChanged event - emitted when fullscreen state flips */
export interface FullscreenChangedPayload {
  isFullscreen: boolean;
}

// =============================================================================
// Event map: links each event name to its payload type so addEventListener,
// removeEventListener, on, and off can infer the right CustomEvent / payload.
// =============================================================================
export type WavedashEventMap = {
  [WavedashEvents.LOBBY_MESSAGE]: LobbyMessagePayload;
  [WavedashEvents.LOBBY_JOINED]: LobbyJoinedPayload;
  [WavedashEvents.LOBBY_KICKED]: LobbyKickedPayload;
  [WavedashEvents.LOBBY_USERS_UPDATED]: LobbyUsersUpdatedPayload;
  [WavedashEvents.LOBBY_DATA_UPDATED]: LobbyDataUpdatedPayload;
  [WavedashEvents.LOBBY_INVITE]: LobbyInvitePayload;
  [WavedashEvents.P2P_CONNECTION_ESTABLISHED]: P2PConnectionEstablishedPayload;
  [WavedashEvents.P2P_CONNECTION_FAILED]: P2PConnectionFailedPayload;
  [WavedashEvents.P2P_PEER_DISCONNECTED]: P2PPeerDisconnectedPayload;
  [WavedashEvents.P2P_PEER_RECONNECTING]: P2PPeerReconnectingPayload;
  [WavedashEvents.P2P_PEER_RECONNECTED]: P2PPeerReconnectedPayload;
  [WavedashEvents.P2P_PACKET_DROPPED]: P2PPacketDroppedPayload;
  [WavedashEvents.STATS_STORED]: StatsStoredPayload;
  [WavedashEvents.BACKEND_CONNECTED]: BackendConnectionPayload;
  [WavedashEvents.BACKEND_DISCONNECTED]: BackendConnectionPayload;
  [WavedashEvents.BACKEND_RECONNECTING]: BackendConnectionPayload;
  [WavedashEvents.FULLSCREEN_CHANGED]: FullscreenChangedPayload;
};

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
}

export interface P2PMessage {
  fromUserId: Id<"users">; // Primary identifier for sender TODO: Make this a small int handle instead of a 32 byte string
  channel: number; // Channel for message routing
  payload: Uint8Array;
  // TODO: Assign an incrementing messsage ID to each message for ordering?
}

// P2P Configuration
export interface P2PConfig {
  enableReliableChannel: boolean;
  enableUnreliableChannel: boolean;
  messageSize?: number; // Max bytes per message slot. Default: 2048. Must be > 44, capped at 65536.
  maxIncomingMessages?: number; // Max queued incoming messages per channel. Default: 1024.
}

// Re-export Id for convenience
export type { Id };
