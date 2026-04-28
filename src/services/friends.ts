/**
 * Friends service
 *
 * Implements friend-related methods for the Wavedash SDK
 */

import type { Friend, Id } from "../types";
import type { WavedashSDK } from "../index";
import { api } from "@wvdsh/api";
import { getCdnImageUrl } from "../utils/cdn";
import { AvatarSize } from "../constants";

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
   * Returns CDN URL with size transformation for a cached user's avatar.
   * @param userId - The user ID to get the avatar URL for
   * @param size - Pixel size for width and height. Use a value from
   *   `AvatarSize` (SMALL=64, MEDIUM=128, LARGE=256) or any custom pixel size.
   * @returns CDN URL with size transformation, or null if user not cached or has no avatar
   */
  getUserAvatarUrl(
    userId: Id<"users">,
    size: number = AvatarSize.MEDIUM
  ): string | null {
    const user = this.userCache.get(userId);
    if (!user?.avatarR2Key) {
      return null;
    }
    return getCdnImageUrl(user.avatarR2Key, this.sdk.uploadsHost, {
      width: size,
      height: size,
      fit: "cover",
      quality: "high",
      sharpen: 1
    });
  }

  /**
   * Returns the cached username for a given user ID
   * @param userId - The user ID to get the username for
   * @returns The username, or null if user not cached
   */
  getUsername(userId: Id<"users">): string | null {
    return this.userCache.get(userId)?.username ?? null;
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
