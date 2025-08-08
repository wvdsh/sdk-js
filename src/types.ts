import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";
import { api, PublicApiType } from "./convex_api";

// Extract types from the API
export type LobbyType = PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["lobbyType"];
export type LeaderboardSortMethod = PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["sortOrder"];
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
}

export interface WavedashUser {
  id: Id<"users">;
  username: string;
}

export interface EngineInstance {
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
  // ... other internal properties and methods
}

// Response types
export interface WavedashResponse<T> {
  success: boolean;
  data: T | null;
  // Return the original args that were passed to the JS SDK so caller can reference them
  args: Record<string, any>;
  // Error message if success is false
  message?: string;
  // TODO: errorCode?
}

// Re-export Id for convenience
export type { Id }; 