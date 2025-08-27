import type {
  Id,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  Leaderboard,
  LeaderboardEntries,
  WavedashResponse,
  UpsertedLeaderboardEntry,
  WavedashUser,
  EngineInstance
} from '../types';
import { api } from '../convex_api';
import type { ConvexClient } from 'convex/browser';
import { WavedashLogger } from '../utils/logger';

export class FileSystemService {
  private engineInstance: EngineInstance | null = null;
  private convexClient: ConvexClient;
  private logger: WavedashLogger;
  constructor(
    convexClient: ConvexClient,
    logger: WavedashLogger,
    engineInstance?: EngineInstance
  ) {
    this.convexClient = convexClient;
    this.logger = logger;
    
    if (engineInstance) {
      this.engineInstance = engineInstance;
    }
  }

  setEngineInstance(engineInstance: EngineInstance): void {
    this.engineInstance = engineInstance;
  }

  
  
}
