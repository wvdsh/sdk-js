/**
 * Heartbeat service
 * 
 * Polls connection state and sends periodic heartbeats to backend
 */

import type { WavedashSDK } from '../index';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { ConnectionState } from 'convex/browser';

export class HeartbeatManager {
  private sdk: WavedashSDK;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected: boolean = false;
  private disconnectedTicks: number = 0;
  private readonly HEARTBEAT_INTERVAL_MS = 1000; // 1 second
  private readonly DISCONNECTED_THRESHOLD_TICKS = 10; // Number of ticks before considering ourselves disconnected

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;
  }

  async start(): Promise<void> {
    // Stop any existing heartbeat
    this.stop();

    // Populate initial connection state
    // @ts-ignore - connectionState exists but may not be in type definitions
    this.isConnected = this.sdk.convexClient.connectionState().isWebSocketConnected;
    await this.updateUserActivity();

    // Start heartbeat interval
    this.heartbeatInterval = setInterval(() => {
      this.tick();
    }, this.HEARTBEAT_INTERVAL_MS);

    // Run immediately
    this.tick();
  }

  stop(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  async updateUserActivity(data?: Record<string, any>): Promise<boolean> {
    try {
      await this.sdk.convexClient.mutation(api.userActivity.updateUserActivity, { data });
      return true;
    } catch (error) {
      this.sdk.logger.error(`Error updating presence: ${error}`);
      return false;
    }
  }

  private async tick(): Promise<void> {
    try {
      // Check local connection state
      const wasConnected = this.isConnected;
      // @ts-ignore - connectionState exists but may not be in type definitions
      const state: ConnectionState = this.sdk.convexClient.connectionState() as ConnectionState;
      this.isConnected = state.isWebSocketConnected;
      const connection = {
        isConnected: state.isWebSocketConnected,
        hasEverConnected: state.hasEverConnected,
        connectionCount: state.connectionCount,
        connectionRetries: state.connectionRetries
      }
      
      // Handle connection state changes
      if (this.isConnected && !wasConnected) {
        // Reconnected
        // Re-update user rich presence in case we were disconnected long enough that
        // the user activity cleared
        await this.updateUserActivity();
        this.disconnectedTicks = 0;
        this.sdk.notifyGame(Signals.BACKEND_CONNECTED, connection);
      } else if (!this.isConnected && wasConnected) {
        // First tick of disconnection - notify reconnecting
        this.disconnectedTicks = 1;
        this.sdk.logger.warn('Backend disconnected - attempting to reconnect');
        this.sdk.notifyGame(Signals.BACKEND_RECONNECTING, connection);
      } else if (!this.isConnected && !wasConnected) {
        // Still disconnected - increment counter
        this.disconnectedTicks++;
        if (this.disconnectedTicks <= this.DISCONNECTED_THRESHOLD_TICKS) {
          this.sdk.logger.warn(`Reconnecting... (${this.disconnectedTicks} / ${this.DISCONNECTED_THRESHOLD_TICKS})`);
        }
        
        // After threshold, notify as truly disconnected
        if (this.disconnectedTicks === this.DISCONNECTED_THRESHOLD_TICKS) {
          this.sdk.notifyGame(Signals.BACKEND_DISCONNECTED, connection);
        }
      } else if (this.isConnected && wasConnected) {
        // Still connected - reset counter
        this.disconnectedTicks = 0;
      }

      // Send heartbeat to backend if connected
      if (this.isConnected) {
        await this.trySendHeartbeat();
      }
    } catch (error) {
      this.sdk.logger.error('Heartbeat failed:', error);
    }
  }

  private async trySendHeartbeat(): Promise<void> {
    try {
      await this.sdk.convexClient.mutation(api.userActivity.heartbeat, {});
    } catch (error) {
      // Don't log every heartbeat error to avoid spam
      // The connection state polling will handle disconnection notification
    }
  }

  isCurrentlyConnected(): boolean {
    // @ts-ignore - connectionState exists but may not be in type definitions
    return this.sdk.convexClient.connectionState().isWebSocketConnected;
  }
}

