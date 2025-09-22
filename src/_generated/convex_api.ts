import { type FunctionReference, anyApi } from "convex/server";
import { type GenericId as Id } from "convex/values";

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
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
    getBySubdomain: FunctionReference<
      "query",
      "public",
      { subdomain: string },
      any
    >;
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
        gameSubdomain: string;
      },
      any
    >;
    consumePlayKey: FunctionReference<
      "mutation",
      "public",
      { playKeyId: Id<"playKeys"> },
      any
    >;
  };
  users: {
    me: FunctionReference<"query", "public", Record<string, never>, any>;
  };
  gameLobby: {
    lobbyUsers: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      Array<{
        isCurrentUser: boolean;
        lobbyId: Id<"lobbies">;
        userId: Id<"users">;
        username: string;
      }>
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
        description?: string;
        title?: string;
        ugcType: 0 | 1 | 2 | 3 | 4;
        userId: Id<"users">;
        visibility: 0 | 1 | 2;
      } | null
    >;
  };
  userGeneratedContent: {
    createUGCItem: FunctionReference<
      "mutation",
      "public",
      {
        createPresignedUploadUrl?: boolean;
        description?: string;
        title?: string;
        ugcType: 0 | 1 | 2 | 3 | 4;
        visibility?: 0 | 1 | 2;
      },
      { ugcId: Id<"userGeneratedContent">; uploadUrl?: string }
    >;
    startUGCUpload: FunctionReference<
      "mutation",
      "public",
      { ugcId: Id<"userGeneratedContent"> },
      string
    >;
    finishUGCUpload: FunctionReference<
      "mutation",
      "public",
      { success: boolean; ugcId: Id<"userGeneratedContent"> },
      boolean
    >;
    getUGCItemDownloadUrl: FunctionReference<
      "query",
      "public",
      { ugcId: Id<"userGeneratedContent"> },
      string
    >;
    updateUGCItem: FunctionReference<
      "mutation",
      "public",
      {
        createPresignedUploadUrl?: boolean;
        description?: string;
        title?: string;
        ugcId: Id<"userGeneratedContent">;
        visibility?: 0 | 1 | 2;
      },
      { ugcId: Id<"userGeneratedContent">; uploadUrl?: string }
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
        score: number;
        ugcId?: Id<"userGeneratedContent">;
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
  developers: {
    organizations: {
      list: FunctionReference<"query", "public", any, any>;
      get: FunctionReference<
        "query",
        "public",
        { orgId: Id<"organizations"> },
        any
      >;
      create: FunctionReference<"mutation", "public", { name: string }, any>;
      update: FunctionReference<
        "mutation",
        "public",
        { name: string; orgId: Id<"organizations"> },
        any
      >;
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
      update: FunctionReference<
        "mutation",
        "public",
        { gameId: Id<"games">; title: string },
        any
      >;
      switchTo: FunctionReference<
        "mutation",
        "public",
        { gameId: Id<"games"> },
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
    getBuildAndBranchFromJwt: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      any
    >;
    getOrCreateSandboxBuildId: FunctionReference<
      "mutation",
      "public",
      { gameBranchId: Id<"gameBranches"> },
      any
    >;
  };
  organizations: {
    getBySlug: FunctionReference<"query", "public", { slug: string }, any>;
  };
  p2pSignaling: {
    sendSignalingMessage: FunctionReference<
      "mutation",
      "public",
      {
        data: any;
        lobbyId: Id<"lobbies">;
        messageType:
          | "offer"
          | "answer"
          | "ice-candidate"
          | "peer-joined"
          | "peer-left";
        toUserId?: Id<"users">;
      },
      any
    >;
    getSignalingMessages: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      any
    >;
    markSignalingMessagesProcessed: FunctionReference<
      "mutation",
      "public",
      { messageIds: Array<Id<"p2pSignalingMessages">> },
      any
    >;
    cleanupExpiredSignalingMessages: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      any
    >;
  };
  remoteFileStorage: {
    getUploadUrl: FunctionReference<
      "mutation",
      "public",
      { path: string },
      string
    >;
  };
  p2pSignaling: {
    sendSignalingMessage: FunctionReference<
      "mutation",
      "public",
      {
        data: any;
        lobbyId: Id<"lobbies">;
        messageType:
          | "offer"
          | "answer"
          | "ice-candidate"
          | "peer-joined"
          | "peer-left";
        toUserId?: Id<"users">;
      },
      any
    >;
    getSignalingMessages: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      any
    >;
    markSignalingMessagesProcessed: FunctionReference<
      "mutation",
      "public",
      { messageIds: Array<Id<"p2pSignalingMessages">> },
      any
    >;
    cleanupExpiredSignalingMessages: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      any
    >;
  };
};
export type InternalApiType = {};
