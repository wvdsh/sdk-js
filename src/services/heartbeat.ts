/**
 * Heartbeat service
 * 
 * Polls connection state and allows the game to update rich user presence
 * Lets the game know if backend connection ever changes.
 * Lets the game update userPresence in the backend
 */

import type { WavedashSDK } from '../index';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { ConnectionState } from 'convex/browser';

export class HeartbeatManager {
  private sdk: WavedashSDK;
  private testConnectionInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected: boolean = false;
  private disconnectedTicks: number = 0;
  private readonly TEST_CONNECTION_INTERVAL_MS = 1_000;
  private readonly DISCONNECTED_TIMEOUT_MS = 60_000;

  // Number of ticks before considering ourselves disconnected
  private readonly DISCONNECTED_THRESHOLD_TICKS = this.DISCONNECTED_TIMEOUT_MS / this.TEST_CONNECTION_INTERVAL_MS;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  start(): void {
    // Stop any existing heartbeat
    this.stop();

    // Populate initial connection state
    // @ts-ignore - connectionState exists but may not be in type definitions
    this.isConnected = this.sdk.convexClient.connectionState().isWebSocketConnected;

    // Check connection interval
    this.testConnectionInterval = setInterval(() => {
      this.testConnection();
    }, this.TEST_CONNECTION_INTERVAL_MS);
  }

  stop(): void {
    if (this.testConnectionInterval !== null) {
      clearInterval(this.testConnectionInterval);
      this.testConnectionInterval = null;
    }
  }

  /**
   * Updates user presence in the backend
   * @param data - Data to send to the backend
   * @returns true if the presence was updated successfully
   */
  async updateUserPresence(data?: Record<string, any>): Promise<boolean> {
    try {
      // Add a default value to guarantee that the presence is updated
      const dataToSend = data ?? { forceUpdate: true };
      await this.sdk.convexClient.mutation(api.presence.heartbeat, { data: dataToSend });
      return true;
    } catch (error) {
      this.sdk.logger.error(`Error updating presence: ${error}`);
      return false;
    }
  }

  /**
   * Tests the connection to the backend
   */
  private async testConnection(): Promise<void> {
    try {
      // Check local connection state
      const wasConnected = this.isConnected;
      // @ts-ignore - connectionState exists but may not be in type definitions
      const state: ConnectionState = this.sdk.convexClient.connectionState() as ConnectionState;
      this.isConnected = navigator.onLine && state.isWebSocketConnected;
      const connection = {
        isConnected: this.isConnected,
        hasEverConnected: state.hasEverConnected,
        connectionCount: state.connectionCount,
        connectionRetries: state.connectionRetries
      }

      // Handle connection state changes
      if (this.isConnected && !wasConnected) {
        // Reconnected
        this.disconnectedTicks = 0;
        this.sdk.notifyGame(Signals.BACKEND_CONNECTED, connection);
      } else if (!this.isConnected && wasConnected) {
        // First tick of disconnection - notify reconnecting
        this.disconnectedTicks = 1;
        this.sdk.logger.warn('Backend disconnected - attempting to reconnect...');
        this.sdk.notifyGame(Signals.BACKEND_RECONNECTING, connection);
      } else if (!this.isConnected && !wasConnected) {
        // Still disconnected - increment counter
        this.disconnectedTicks++;
        // After threshold, notify as truly disconnected
        if (this.disconnectedTicks === this.DISCONNECTED_THRESHOLD_TICKS) {
          this.sdk.notifyGame(Signals.BACKEND_DISCONNECTED, connection);
        }
      } else if (this.isConnected && wasConnected) {
        // Still connected - reset counter
        this.disconnectedTicks = 0;
      }
    } catch (error) {
      this.sdk.logger.error('Error testing connection:', error);
    }
  }

  isCurrentlyConnected(): boolean {
    return this.isConnected;
  }
}

