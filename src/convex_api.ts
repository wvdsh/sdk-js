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
    get: FunctionReference<
      "query",
      "public",
      { orgSlug: string; slug: string },
      any
    >;
    hasUserPurchased: FunctionReference<
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
    launchGame: FunctionReference<
      "mutation",
      "public",
      { gameId: Id<"games"> },
      any
    >;
  };
  gameLobby: {
    lobbyUsers: FunctionReference<
      "query",
      "public",
      { gameSessionToken: string; lobbyId: Id<"lobbies"> },
      any
    >;
    createAndJoinLobby: FunctionReference<
      "mutation",
      "public",
      { gameSessionToken: string },
      any
    >;
    joinLobby: FunctionReference<
      "mutation",
      "public",
      { gameSessionToken: string; lobbyId: Id<"lobbies"> },
      any
    >;
    leaveLobby: FunctionReference<
      "mutation",
      "public",
      { gameSessionToken: string; lobbyId: Id<"lobbies"> },
      any
    >;
    sendMessage: FunctionReference<
      "mutation",
      "public",
      { gameSessionToken: string; lobbyId: Id<"lobbies">; message: string },
      any
    >;
    lobbyMessages: FunctionReference<
      "query",
      "public",
      { gameSessionToken: string; lobbyId: Id<"lobbies"> },
      any
    >;
  };
};
export type InternalApiType = {};
