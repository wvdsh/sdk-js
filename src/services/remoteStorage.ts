/**
 * Remote file storage service
 * 
 * Exposes a specific remote folder for the game to save user-specific files to.
 * TODO: Extend this to game-level assets as well.
 */

import type {
  WavedashResponse
} from '../types';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';

export async function remoteFileExists(this: WavedashSDK, filePath: string): Promise<WavedashResponse<boolean>> {
  const args = { filePath };

  return false;
}