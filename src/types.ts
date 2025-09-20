import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";
import { api, PublicApiType } from "./_generated/convex_api";
import { P2P_SIGNALING_MESSAGE_TYPE } from "./_generated/constants";
import { Signals } from "./signals";

// Extract types from the API
export type LobbyType = PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["lobbyType"];
export type LobbyUsers = FunctionReturnType<typeof api.gameLobby.lobbyUsers>;
export type UGCType = PublicApiType["userGeneratedContent"]["createUGCItem"]["_args"]["ugcType"];
export type UGCVisibility = PublicApiType["userGeneratedContent"]["createUGCItem"]["_args"]["visibility"];
export type LeaderboardSortOrder = PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["sortOrder"];
export type LeaderboardDisplayType = PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["displayType"];
export type Leaderboard = FunctionReturnType<typeof api.leaderboards.getLeaderboard>;
export type LeaderboardEntries = FunctionReturnType<typeof api.leaderboards.listEntriesAroundUser>["entries"];
export type UpsertedLeaderboardEntry = FunctionReturnType<typeof api.leaderboards.upsertLeaderboardEntry>["entry"] & {
  userId: Id<"users">;
  username: string;
};

// Type helper to get signal values as a union type
export type Signal = typeof Signals[keyof typeof Signals];

// Configuration and user types
export interface WavedashConfig {
  gameId: Id<"games">;
  debug?: boolean;
  remoteStorageOrigin?: string;
  p2p?: Partial<P2PConfig>;
}

export interface WavedashUser {
  id: Id<"users">;
  username: string;
}

export interface RemoteFileMetadata {
  exists: boolean;  // Whether the entry exists
  key: string;  // R2 Key of the entry
  name: string;  // Name of the entry relative to the requested directory path
  lastModified: number;  // Last modified timestamp of the entry (ISO format)
  size: number;  // Size of the entry in bytes
  etag: string;  // ETag of the entry
}

export enum GameEngine {
  Godot="GODOT",
  Unity="UNITY",
  Custom="CUSTOM",
}

export interface EngineInstance {
  // Add more as we support more engines
  type: GameEngine;
  // Broadcasts a message to the engine instance
  // Exposed natively by Unity's engine instance, added manually by Wavedash Godot SDK
  SendMessage(objectName: string, methodName: Signal, value?: string | number | boolean): void;
  // Standard Emscripten filesystem API: https://emscripten.org/docs/api_reference/Filesystem-API.html
  FS: {
    readFile(path: string, opts?: Record<string, any>): string | Uint8Array;
    writeFile(path: string, data: string | ArrayBufferView, opts?: Record<string, any>): void;
    syncfs(populate: boolean, callback?: (err: any) => void): void;
    analyzePath(path: string): { exists: boolean };
    // ... other functions
  }
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
  handle: number;           // Integer handle for networking performance
  userId: Id<"users">;      // Links to persistent user
  username: string;
  isHost: boolean;
}

export interface P2PConnection {
  lobbyId: Id<"lobbies">;
  localHandle: number;
  peers: Record<number, P2PPeer>;  // handle -> peer info (JSON serializable)
  state: P2PConnectionState;
}

export type P2PConnectionState = 
  | "connecting" 
  | "connected" 
  | "disconnected" 
  | "failed";

export interface P2PMessage {
  fromHandle: number;
  toHandle?: number;        // undefined = broadcast
  channel: number;          // Channel for message routing
  data: any;
  timestamp: number;
}

export interface P2PSignalingMessage {  
  type: typeof P2P_SIGNALING_MESSAGE_TYPE[keyof typeof P2P_SIGNALING_MESSAGE_TYPE];
  fromHandle?: number;
  toHandle: number;
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