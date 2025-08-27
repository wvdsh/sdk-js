import type {
  Id,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry,
  WavedashUser
} from '../types';
import { api } from '../convex_api';
import type { ConvexClient } from 'convex/browser';
import { WavedashLogger } from '../utils/logger';

export class FileSystemService {
  constructor(
    private convexClient: ConvexClient,
    private wavedashUser: WavedashUser,
    private logger: WavedashLogger
  ) { }

  test(a: string) {
    this.logger.debug(a);
    this.logger.info(a);
    this.logger.warn(a);
    this.logger.error(a);
  }
}
