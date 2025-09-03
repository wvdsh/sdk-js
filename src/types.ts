import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";
import { api, PublicApiType } from "./_generated/convex_api";

// Extract types from the API
export type LobbyType = PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["lobbyType"];
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

// Configuration and user types
export interface WavedashConfig {
  gameId: Id<"games">;
  debug?: boolean;
  remoteStorageOrigin?: string;
}

export interface WavedashUser {
  id: Id<"users">;
  username: string;
}

export interface EngineInstance {
  // Add more as we support more engines
  type: "GODOT" | "UNITY";
  // Broadcasts a message to the engine instance
  // Exposed natively by Unity's engine instance, added manually by Wavedash Godot SDK
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
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

// Re-export Id for convenience
export type { Id }; 