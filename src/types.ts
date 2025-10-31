import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";
import { api, PublicApiType } from "./_generated/convex_api";
import {
  GAME_ENGINE,
  P2P_SIGNALING_MESSAGE_TYPE,
} from "./_generated/constants";
import { Signals } from "./signals";

// Extract types from the API
export type LobbyVisibility =
  PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["visibility"];
export type LobbyUser = FunctionReturnType<typeof api.gameLobby.lobbyUsers>[0];
export type LobbyMessage = FunctionReturnType<
  typeof api.gameLobby.lobbyMessages
>[0];
export type Lobby = FunctionReturnType<typeof api.gameLobby.listAvailable>[0];
export type UGCType =
  PublicApiType["userGeneratedContent"]["createUGCItem"]["_args"]["ugcType"];
export type UGCVisibility =
  PublicApiType["userGeneratedContent"]["createUGCItem"]["_args"]["visibility"];
export type LeaderboardSortOrder =
  PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["sortOrder"];
export type LeaderboardDisplayType =
  PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["displayType"];
export type Leaderboard = FunctionReturnType<
  typeof api.leaderboards.getLeaderboard
>;
export type LeaderboardEntries = FunctionReturnType<
  typeof api.leaderboards.listEntriesAroundUser
>["entries"];
export type UpsertedLeaderboardEntry = FunctionReturnType<
  typeof api.leaderboards.upsertLeaderboardEntry
>["entry"] & {
  userId: Id<"users">;
  username: string;
};

// Type helper to get signal values as a union type
export type Signal = (typeof Signals)[keyof typeof Signals];

// Configuration and user types
export interface WavedashConfig {
  gameId: Id<"games">;
  debug?: boolean;
  remoteStorageOrigin?: string;
  p2p?: Partial<P2PConfig>;
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
    readFile(path: string, opts?: Record<string, any>): string | Uint8Array;
    writeFile(
      path: string,
      data: string | ArrayBufferView,
      opts?: Record<string, any>
    ): void;
    mkdirTree(path: string, mode?: number): void;
    syncfs(populate: boolean, callback?: (err: any) => void): void;
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
  args: Record<string, any>;
  // Error message if success is false
  message?: string;
  // TODO: errorCode?
}

// P2P Connection types
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

export interface P2PSignalingMessage {
  type: (typeof P2P_SIGNALING_MESSAGE_TYPE)[keyof typeof P2P_SIGNALING_MESSAGE_TYPE];
  fromUserId?: Id<"users">; // Primary identifier for sender
  toUserId: Id<"users">; // Primary identifier for recipient
  data: any;
}

// P2P Configuration
export interface P2PConfig {
  iceServers: RTCIceServer[];
  maxPeers: number;
  enableReliableChannel: boolean;
  enableUnreliableChannel: boolean;
}

// Re-export Id for convenience
export type { Id };
