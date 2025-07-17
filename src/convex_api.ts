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
    get: FunctionReference<
      "query",
      "public",
      { orgSlug: string; slug: string },
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
    getById: FunctionReference<"query", "public", { id: Id<"games"> }, any>;
    createPlayKey: FunctionReference<
      "mutation",
      "public",
      { gameBuildId?: Id<"gameBuilds">; gameId: Id<"games"> },
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
      any
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
    getLeaderboard: FunctionReference<
      "query",
      "public",
      { name: string },
      { id: Id<"leaderboards">; name: string; numEntries: number } | null
    >;
    getOrCreateLeaderboard: FunctionReference<
      "mutation",
      "public",
      { displayType?: 0 | 1 | 2; name: string; sortOrder?: 0 | 1 },
      {
        created: boolean;
        id: Id<"leaderboards">;
        name: string;
        numEntries: number;
      }
    >;
    attachLeaderboardUGC: FunctionReference<
      "mutation",
      "public",
      { leaderboardId: Id<"leaderboards">; ugcId: Id<"userGeneratedContent"> },
      boolean
    >;
  };
  organizations: {
    list: FunctionReference<"query", "public", any, any>;
    current: FunctionReference<"query", "public", any, any>;
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
        { orgId?: Id<"organizations">; sessionToken: string },
        any
      >;
      switchOrganization: FunctionReference<
        "mutation",
        "public",
        { organizationId: Id<"organizations">; sessionToken: string },
        any
      >;
    };
  };
  gameBuilds: {
    getIfPurchased: FunctionReference<
      "query",
      "public",
      { gameBuildId: Id<"gameBuilds"> },
      any
    >;
  };
};
export type InternalApiType = {};
