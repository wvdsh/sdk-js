import { type GenericId as Id } from "convex/values";
import { type FunctionReturnType } from "convex/server";
import { api, PublicApiType } from "./convex_api";

// Extract types from the API
export type LobbyType = PublicApiType["gameLobby"]["createAndJoinLobby"]["_args"]["lobbyType"];
export type LeaderboardSortMethod = PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["sortOrder"];
export type LeaderboardDisplayType = PublicApiType["leaderboards"]["getOrCreateLeaderboard"]["_args"]["displayType"];
export type Leaderboard = FunctionReturnType<typeof api.leaderboards.getLeaderboard>;
export type LeaderboardEntries = FunctionReturnType<typeof api.leaderboards.listEntriesAroundRank>;
export type LeaderboardEntry = LeaderboardEntries["entries"][0];

// Configuration and user types
export interface WavedashConfig {
  gameId: string;
  debug?: boolean;
}

export interface WavedashUser {
  id: string;
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
  args: Record<string, any>;
  message?: string;
  // TODO: errorCode?
}

// Re-export Id for convenience
export type { Id }; 