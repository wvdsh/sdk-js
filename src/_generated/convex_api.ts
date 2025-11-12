import { type FunctionReference, anyApi } from "convex/server";
import { type GenericId as Id } from "convex/values";

export const api: PublicApiType = anyApi as unknown as PublicApiType;
export const internal: InternalApiType = anyApi as unknown as InternalApiType;

export type PublicApiType = {
  users: {
    me: FunctionReference<"query", "public", Record<string, never>, any>;
  };
  games: {
    createCheckoutSession: FunctionReference<
      "action",
      "public",
      { gameId: Id<"games">; returnUrl: string },
      any
    >;
    createPlayKey: FunctionReference<
      "mutation",
      "public",
      {
        gameBranchId?: Id<"gameBranches">;
        gameBuildId?: Id<"gameBuilds">;
        slug: string;
      },
      any
    >;
    getPurchasedGameOrThrow: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
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
        sortType?: "alphabetical" | "most-played" | "recently-played";
      },
      any
    >;
    getFeatured: FunctionReference<"query", "public", any, any>;
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
    getBySlug: FunctionReference<"query", "public", { slug: string }, any>;
    getGameAndAccess: FunctionReference<
      "query",
      "public",
      { slug: string },
      any
    >;
    consumePlayKey: FunctionReference<
      "mutation",
      "public",
      { playKeyIdOrCode: Id<"playKeys"> | string },
      any
    >;
  };
  gameLobby: {
    createAndJoinLobby: FunctionReference<
      "mutation",
      "public",
      { maxPlayers?: number; visibility: 0 | 1 | 2 },
      Id<"lobbies">
    >;
    getLobbyMetadata: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      Record<string, any>
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
      boolean
    >;
    listAvailable: FunctionReference<
      "query",
      "public",
      { filters?: Record<string, any> },
      Array<{
        lobbyId: Id<"lobbies">;
        maxPlayers: number;
        metadata: Record<string, any>;
        playerCount: number;
        visibility: 0 | 1 | 2;
      }>
    >;
    lobbyMessages: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      Array<{
        lobbyId: Id<"lobbies">;
        message: string;
        messageId: Id<"lobbyMessages">;
        timestamp: number;
        userId: Id<"users">;
        username: string;
      }>
    >;
    lobbyUsers: FunctionReference<
      "query",
      "public",
      { lobbyId: Id<"lobbies"> },
      Array<{
        isHost: boolean;
        lobbyId: Id<"lobbies">;
        userId: Id<"users">;
        username: string;
      }>
    >;
    sendMessage: FunctionReference<
      "mutation",
      "public",
      { lobbyId: Id<"lobbies">; message: string },
      string
    >;
    setLobbyMetadata: FunctionReference<
      "mutation",
      "public",
      { lobbyId: Id<"lobbies">; updates: Record<string, any> },
      boolean
    >;
  };
  ugcAccess: {
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
    getLeaderboardEntries: FunctionReference<
      "query",
      "public",
      { leaderboardId: Id<"leaderboards">; limit?: number },
      any
    >;
    getLeaderboardsForGame: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
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
  auth: {
    oauth: {
      googleOAuthCallback: FunctionReference<
        "action",
        "public",
        { code: string; origin: string },
        any
      >;
    };
    sessionTokens: {
      authenticateUserForGame: FunctionReference<
        "mutation",
        "public",
        {
          gameBranchId?: Id<"gameBranches">;
          gameBuildId?: Id<"gameBuilds">;
          gameSlug: string;
          isSandbox?: boolean;
        },
        any
      >;
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
    emailPassword: {
      changePassword: FunctionReference<
        "mutation",
        "public",
        { currentPassword: string; newPassword: string },
        any
      >;
      sendVerificationEmail: FunctionReference<
        "mutation",
        "public",
        Record<string, never>,
        any
      >;
      signUp: FunctionReference<
        "mutation",
        "public",
        { email: string; password: string },
        any
      >;
      signIn: FunctionReference<
        "mutation",
        "public",
        { email: string; password: string },
        any
      >;
      verifyEmail: FunctionReference<
        "mutation",
        "public",
        { token: string },
        any
      >;
      requestPasswordReset: FunctionReference<
        "mutation",
        "public",
        { email: string },
        any
      >;
      resetPassword: FunctionReference<
        "mutation",
        "public",
        { newPassword: string; token: string },
        any
      >;
    };
    linking: {
      getLinkedAuthMethods: FunctionReference<
        "query",
        "public",
        Record<string, never>,
        any
      >;
      linkEmailPassword: FunctionReference<
        "mutation",
        "public",
        { email: string; password: string },
        any
      >;
      linkOAuthAccount: FunctionReference<
        "mutation",
        "public",
        {
          provider: "google";
          providerAccountId: string;
          providerEmail: string;
        },
        any
      >;
      unlinkAuthMethod: FunctionReference<
        "mutation",
        "public",
        { method: "email_password" | string },
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
  organizations: {
    getBySlug: FunctionReference<"query", "public", { slug: string }, any>;
    get: FunctionReference<
      "query",
      "public",
      { orgId: Id<"organizations"> },
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
        messageType: "offer" | "answer" | "ice-candidate";
        toUserId: Id<"users">;
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
  };
  presence: {
    heartbeat: FunctionReference<
      "mutation",
      "public",
      {
        browsingSection?: string | null;
        data?: Record<string, any>;
        gameCloudId?: Id<"gameClouds">;
      },
      any
    >;
    myActivePresence: FunctionReference<
      "query",
      "public",
      any,
      {
        avatarUrl?: string;
        browsingSection?: string;
        currentlyActive: boolean;
        gameName?: string;
        lastActiveAt?: number;
        presenceType: 5 | 10;
        userId: Id<"users">;
        username: string;
      }
    >;
    listOnlineFriends: FunctionReference<
      "query",
      "public",
      any,
      Array<{
        avatarUrl?: string;
        browsingSection?: string;
        currentlyActive: boolean;
        gameName?: string;
        lastActiveAt?: number;
        presenceType: 5 | 10;
        userId: Id<"users">;
        username: string;
      }>
    >;
    listOfflineFriends: FunctionReference<
      "query",
      "public",
      any,
      Array<{
        avatarUrl?: string;
        browsingSection?: string;
        currentlyActive: boolean;
        gameName?: string;
        lastActiveAt?: number;
        presenceType: 5 | 10;
        userId: Id<"users">;
        username: string;
      }>
    >;
    endUserPresence: FunctionReference<
      "mutation",
      "public",
      { gameCloudId?: Id<"gameClouds"> },
      any
    >;
  };
  gameAchievements: {
    getAllAchievementsWithProgress: FunctionReference<
      "query",
      "public",
      { gameCloudId: Id<"gameClouds"> },
      Array<{
        achievement: {
          _id: Id<"gameAchievements">;
          description: string;
          displayName: string;
          image: string;
          points: number;
        };
        completedAt?: number;
        currentValue?: number;
        isCompleted: boolean;
        targetValue?: number;
      }>
    >;
    getMyStatsForGame: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      Array<{ identifier: string; value: number }>
    >;
    getTotalPointsForUserAndGame: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      number
    >;
    setUserGameAchievements: FunctionReference<
      "mutation",
      "public",
      { achievements: Array<string> },
      any
    >;
    setUserGameStats: FunctionReference<
      "mutation",
      "public",
      { stats: Array<{ identifier: string; value: number }> },
      any
    >;
    getMyAchievementsForGame: FunctionReference<
      "query",
      "public",
      { gameCloudId?: Id<"gameClouds">; since?: number },
      Array<{
        achievement: {
          _creationTime: number;
          _id: Id<"gameAchievements">;
          description: string;
          displayName: string;
          identifier: string;
          image: string;
          points: number;
        };
        completedAt: number;
      }>
    >;
    getAchievementsForGame: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
    >;
    getTotalPointsForUser: FunctionReference<
      "query",
      "public",
      { userId: Id<"users"> },
      number
    >;
  };
  userTracking: {
    getLastPlayedAt: FunctionReference<
      "query",
      "public",
      { gameCloudId: Id<"gameClouds">; userId: Id<"users"> },
      number | null
    >;
    getTotalPlaytimeByGame: FunctionReference<
      "query",
      "public",
      { gameCloudId: Id<"gameClouds"> },
      number
    >;
    getTotalPlaytimeByUser: FunctionReference<
      "query",
      "public",
      { userId: Id<"users"> },
      number
    >;
    getTotalPlaytimeByUserAndGame: FunctionReference<
      "query",
      "public",
      { gameCloudId: Id<"gameClouds">; userId: Id<"users"> },
      number
    >;
  };
  turnCredentials: {
    getTurnCredentials: FunctionReference<
      "query",
      "public",
      Record<string, never>,
      {
        expiresAt: number;
        iceServers: Array<{
          credential?: string;
          url?: string;
          urls: string | Array<string>;
          username?: string;
        }>;
      } | null
    >;
    refreshTurnCredentials: FunctionReference<
      "action",
      "public",
      Record<string, never>,
      any
    >;
  };
  stripe: {
    checkout: {
      createCheckoutSession: FunctionReference<
        "action",
        "public",
        { gameId: Id<"games">; returnUrl: string },
        any
      >;
    };
  };
  gameReviews: {
    getReviewStats: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
    >;
    getReviewsForGame: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
    >;
  };
  wishlist: {
    add: FunctionReference<"mutation", "public", { gameId: Id<"games"> }, any>;
    isInWishlist: FunctionReference<
      "query",
      "public",
      { gameId: Id<"games"> },
      any
    >;
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
    remove: FunctionReference<
      "mutation",
      "public",
      { gameId: Id<"games"> },
      any
    >;
  };
  account: {
    cancelEmailChange: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      any
    >;
    deleteAccount: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      any
    >;
    resendEmailChangeVerification: FunctionReference<
      "mutation",
      "public",
      Record<string, never>,
      any
    >;
    updateEmail: FunctionReference<
      "mutation",
      "public",
      { newEmail: string },
      any
    >;
    updateUsername: FunctionReference<
      "mutation",
      "public",
      { newUsername: string },
      any
    >;
    verifyEmailChange: FunctionReference<
      "mutation",
      "public",
      { token: string },
      any
    >;
  };
  friends: {
    acceptFriendRequest: FunctionReference<
      "mutation",
      "public",
      { requestId: Id<"friendRequests"> },
      boolean
    >;
    listFriendRequests: FunctionReference<"query", "public", any, any>;
    rejectFriendRequest: FunctionReference<
      "mutation",
      "public",
      { requestId: Id<"friendRequests"> },
      boolean
    >;
    sendFriendRequest: FunctionReference<
      "mutation",
      "public",
      { toUserId: Id<"users"> },
      boolean
    >;
  };
};
export type InternalApiType = {};
