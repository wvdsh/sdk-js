import { type FunctionReference, anyApi } from "convex/server";
import { type GenericId as Id } from "convex/values";

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  users: {
    me: FunctionReference<"query", "public", Record<string, never>, any>;
  };
  games: {
    list: FunctionReference<
      "query",
      "public",
      {
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
      },
      any
    >;
    getById: FunctionReference<"query", "public", { id: Id<"games"> }, any>;
    getBySlug: FunctionReference<"query", "public", { slug: string }, any>;
    getGameOrgAndAccess: FunctionReference<
      "query",
      "public",
      { orgSlug: string; slug: string },
      any
    >;
    listPurchased: FunctionReference<
      "query",
      "public",
      {
        paginationOpts: {
          cursor: string | null;
          endCursor?: string | null;
          id?: number;
          maximumBytesRead?: number;
          maximumRowsRead?: number;
          numItems: number;
        };
      },
      any
    >;
    getPurchasedGameOrThrow: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
    >;
    purchaseGame: FunctionReference<
      "mutation",
      "public",
      { gameId: Id<"games"> },
      any
    >;
    createPlayKey: FunctionReference<
      "mutation",
      "public",
      {
        gameBranchId?: Id<"gameBranches">;
        gameBuildId?: Id<"gameBuilds">;
        gameId: Id<"games">;
      },
      any
    >;
  };
  gameLobby: {
    lobbyUsers: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      any
    >;
    createAndJoinLobby: FunctionReference<
      "mutation",
      "public",
      { lobbyType: 0 | 1 | 2; maxPlayers?: number },
      any
    >;
    joinLobby: FunctionReference<
      "mutation",
      "public",
      { lobbyId: Id<"lobbies"> },
      boolean
    >;
    leaveLobby: FunctionReference<
      "mutation",
      "public",
      { lobbyId: Id<"lobbies"> },
      any
    >;
    sendMessage: FunctionReference<
      "mutation",
      "public",
      { lobbyId: Id<"lobbies">; message: string },
      any
    >;
    lobbyMessages: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      any
    >;
  };
  ugcAccess: {
    getUGCDownloadUrl: FunctionReference<
      "query",
      "public",
      { ugcId: Id<"userGeneratedContent"> },
      { isPublic: boolean; url: string } | null
    >;
    getUGCMetadata: FunctionReference<
      "query",
      "public",
      { ugcId: Id<"userGeneratedContent"> },
      {
        _creationTime: number;
        _id: Id<"userGeneratedContent">;
        canAccess: boolean;
        contentType: number;
        description?: string;
        title?: string;
        userId: Id<"users">;
        visibility: number;
      } | null
    >;
  };
  userGeneratedContent: {
    createEmptyUGCItem: FunctionReference<
      "mutation",
      "public",
      { contentType: 0 | 1 | 2 | 3 | 4; gameSessionToken: string },
      { ugcId: Id<"userGeneratedContent">; uploadUrl: string }
    >;
    updateUGCItem: FunctionReference<
      "mutation",
      "public",
      {
        contentType: 0 | 1 | 2 | 3 | 4;
        description?: string;
        metadata?: ArrayBuffer;
        title?: string;
        ugcId: Id<"userGeneratedContent">;
        visibility: 0 | 1 | 2;
      },
      boolean
    >;
    deleteUGCItem: FunctionReference<
      "mutation",
      "public",
      { ugcId: Id<"userGeneratedContent"> },
      boolean
    >;
  };
  leaderboards: {
    attachLeaderboardUGC: FunctionReference<
      "mutation",
      "public",
      { leaderboardId: Id<"leaderboards">; ugcId: Id<"userGeneratedContent"> },
      boolean
    >;
    getLeaderboard: FunctionReference<
      "query",
      "public",
      { name: string },
      { id: Id<"leaderboards">; name: string; totalEntries: number }
    >;
    getMyLeaderboardEntry: FunctionReference<
      "query",
      "public",
      { leaderboardId: Id<"leaderboards"> },
      {
        entry: null | {
          globalRank: number;
          metadata?: ArrayBuffer;
          score: number;
          timestamp: number;
          ugcId?: Id<"userGeneratedContent">;
        };
        totalEntries: number;
      }
    >;
    getOrCreateLeaderboard: FunctionReference<
      "mutation",
      "public",
      { displayType?: 0 | 1 | 2; name: string; sortOrder?: 0 | 1 },
      {
        created: boolean;
        id: Id<"leaderboards">;
        name: string;
        totalEntries: number;
      }
    >;
    listEntries: FunctionReference<
      "query",
      "public",
      { leaderboardId: Id<"leaderboards">; limit: number; offset: number },
      {
        entries: Array<{
          globalRank: number;
          metadata?: ArrayBuffer;
          score: number;
          timestamp: number;
          ugcId?: Id<"userGeneratedContent">;
          userId: Id<"users">;
          username?: string;
        }>;
        totalEntries: number;
      }
    >;
    listEntriesAroundUser: FunctionReference<
      "query",
      "public",
      {
        countAhead: number;
        countBehind: number;
        leaderboardId: Id<"leaderboards">;
      },
      {
        entries: Array<{
          globalRank: number;
          metadata?: ArrayBuffer;
          score: number;
          timestamp: number;
          ugcId?: Id<"userGeneratedContent">;
          userId: Id<"users">;
          username?: string;
        }>;
        totalEntries: number;
      }
    >;
    upsertLeaderboardEntry: FunctionReference<
      "mutation",
      "public",
      {
        keepBest: boolean;
        leaderboardId: Id<"leaderboards">;
        metadata?: ArrayBuffer;
        score: number;
      },
      {
        entry: {
          entryId: Id<"leaderboardEntries">;
          globalRank: number;
          score: number;
          scoreChanged: boolean;
        };
        totalEntries: number;
      }
    >;
  };
  organizations: {
    getBySlug: FunctionReference<"query", "public", { slug: string }, any>;
  };
  auth: {
    oauth: {
      googleOAuthCallback: FunctionReference<
        "action",
        "public",
        { code: string; origin: string },
        any
      >;
    };
    sessions: {
      logout: FunctionReference<
        "mutation",
        "public",
        { sessionToken: string },
        any
      >;
      refresh: FunctionReference<
        "mutation",
        "public",
        { sessionToken: string },
        any
      >;
    };
  };
  developers: {
    games: {
      list: FunctionReference<
        "query",
        "public",
        { orgId: Id<"organizations"> },
        any
      >;
      get: FunctionReference<"query", "public", { gameId: Id<"games"> }, any>;
      create: FunctionReference<
        "mutation",
        "public",
        { orgId: Id<"organizations">; title: string },
        any
      >;
      del: FunctionReference<
        "mutation",
        "public",
        { gameId: Id<"games"> },
        any
      >;
      switchTo: FunctionReference<
        "mutation",
        "public",
        { gameId: Id<"games"> },
        any
      >;
    };
    organizations: {
      list: FunctionReference<"query", "public", any, any>;
      get: FunctionReference<
        "query",
        "public",
        { orgId: Id<"organizations"> },
        any
      >;
      create: FunctionReference<"mutation", "public", { name: string }, any>;
      del: FunctionReference<
        "mutation",
        "public",
        { orgId: Id<"organizations"> },
        any
      >;
      switchTo: FunctionReference<
        "mutation",
        "public",
        { orgId: Id<"organizations"> },
        any
      >;
    };
    apiKeys: {
      list: FunctionReference<"query", "public", Record<string, never>, any>;
      create: FunctionReference<"mutation", "public", { name: string }, any>;
      del: FunctionReference<
        "mutation",
        "public",
        { keyId: Id<"apiKeys"> },
        any
      >;
    };
    gameBranches: {
      list: FunctionReference<"query", "public", { gameId: Id<"games"> }, any>;
      listAvailable: FunctionReference<
        "query",
        "public",
        { gameId: Id<"games"> },
        any
      >;
      listClouds: FunctionReference<
        "query",
        "public",
        Record<string, never>,
        any
      >;
      get: FunctionReference<
        "query",
        "public",
        { gameBranchId: Id<"gameBranches"> },
        any
      >;
      create: FunctionReference<
        "mutation",
        "public",
        {
          gameCloud: "SANDBOX" | "PRODUCTION";
          gameId: Id<"games">;
          name: string;
          r2Key?: string;
          type:
            | "INTERNAL"
            | "PRODUCTION"
            | "DEMO"
            | "PLAYTEST"
            | "ALPHA"
            | "BETA";
        },
        any
      >;
      switchTo: FunctionReference<
        "mutation",
        "public",
        { gameBranchId: Id<"gameBranches"> },
        any
      >;
    };
    gameBuilds: {
      list: FunctionReference<
        "query",
        "public",
        {
          gameBranchId: Id<"gameBranches">;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        any
      >;
      del: FunctionReference<
        "mutation",
        "public",
        { buildId: Id<"gameBuilds"> },
        any
      >;
    };
  };
  gameBuilds: {
    get: FunctionReference<"query", "public", Record<string, never>, any>;
  };
};
export type InternalApiType = {};
