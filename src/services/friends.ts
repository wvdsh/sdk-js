/**
 * Friends service
 *
 * Implements friend-related methods for the Wavedash SDK
 */

import type { Friend, Id } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/types";
import { getCdnImageUrl } from "../utils/cdn";

// Avatar size constants
export const AVATAR_SIZE_SMALL = 0; // 64px - Lists, chat bubbles
export const AVATAR_SIZE_MEDIUM = 1; // 128px - Profile cards
export const AVATAR_SIZE_LARGE = 2; // 256px - Large displays

const AVATAR_DIMENSIONS = [64, 128, 256]; // Indexed by size constant

interface CachedUser {
  username: string;
  avatarR2Key?: string; // The r2Key (backend returns this as "avatarUrl")
}

export class FriendsManager {
  private sdk: WavedashSDK;
  private userCache: Map<Id<"users">, CachedUser> = new Map();

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  /**
   * Cache users from any source (friends, lobby users)
   * Accepts both Friend format (avatarUrl) and LobbyUser format (userAvatarUrl)
   * @param users - Array of users with userId, username, and optional avatar r2Key
   */
  cacheUsers(
    users: Array<{
      userId: Id<"users">;
      username: string;
      avatarUrl?: string;
      userAvatarUrl?: string;
    }>
  ): void {
    for (const user of users) {
      this.userCache.set(user.userId, {
        username: user.username,
        // Support both Friend (avatarUrl) and LobbyUser (userAvatarUrl) formats
        avatarR2Key: user.avatarUrl ?? user.userAvatarUrl
      });
    }
  }

  /**
   * Returns CDN URL with size transformation for a cached user's avatar
   * @param userId - The user ID to get the avatar URL for
   * @param size - Avatar size constant (AVATAR_SIZE_SMALL, AVATAR_SIZE_MEDIUM, or AVATAR_SIZE_LARGE)
   * @returns CDN URL with size transformation, or null if user not cached or has no avatar
   */
  getUserAvatarUrl(
    userId: Id<"users">,
    size: number = AVATAR_SIZE_MEDIUM
  ): string | null {
    const user = this.userCache.get(userId);
    if (!user?.avatarR2Key) {
      return null;
    }
    const dimension =
      AVATAR_DIMENSIONS[size] ?? AVATAR_DIMENSIONS[AVATAR_SIZE_MEDIUM];
    return getCdnImageUrl(user.avatarR2Key, this.sdk.uploadsHost, {
      width: dimension,
      height: dimension,
      fit: "cover",
      quality: "high",
      sharpen: 1
    });
  }

  async listFriends(): Promise<Friend[]> {
    const friends = await this.sdk.convexClient.query(
      api.sdk.friends.listFriends,
      {}
    );
    this.cacheUsers(friends);
    return friends;
  }
}
