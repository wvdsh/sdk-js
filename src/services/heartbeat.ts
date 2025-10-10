/**
 * Heartbeat service
 * 
 * Polls connection state and sends periodic heartbeats to backend.
 * Lets the game know if backend connection ever changes.
 * Lets the backend know game presence is still alive.
 */

import type { WavedashSDK } from '../index';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { ConnectionState } from 'convex/browser';
import { GAMEPLAY_HEARTBEAT } from '../_generated/constants';

export class HeartbeatManager {
  private sdk: WavedashSDK;
  private sendHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private testConnectionInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected: boolean = false;
  private disconnectedTicks: number = 0;
  private isHeartbeatInProgress: boolean = false;
  private convexHttpOrigin: string;
  private readonly SEND_HEARTBEAT_INTERVAL_MS = GAMEPLAY_HEARTBEAT.INTERVAL_MS;
  private readonly TEST_CONNECTION_INTERVAL_MS = 1_000;
  // Number of ticks before considering ourselves disconnected
  private readonly DISCONNECTED_THRESHOLD_TICKS = GAMEPLAY_HEARTBEAT.TIMEOUT_MS / this.TEST_CONNECTION_INTERVAL_MS;

  constructor(sdk: WavedashSDK) {
    this.sdk = sdk;

    // Cache the Convex HTTP origin once at initialization
    this.convexHttpOrigin = this.getConvexHttpOrigin();

    // Try to end user presence when the tab actually closes / navigates away
    // TODO: Should we do this every time the tab is hidden? And mark you present when it comes back?
    // You'd rack up a lot of game sessions but we'd get more granular tracking
    if (typeof window !== 'undefined' && this.convexHttpOrigin) {
      window.addEventListener('pagehide', (event) => {
        // Send a beacon POST request to the backend to end user presence
        navigator.sendBeacon(`${this.convexHttpOrigin}/webhooks/end-user-presence`);
      }, { capture: true });
    }
  }

  private getConvexHttpOrigin(): string {
    if (typeof window !== 'undefined' && window.location) {
      const hostname = window.location.hostname;
      const parts = hostname.split('.');
      return `${window.location.protocol}//convex-http.` + parts.slice(1).join('.');
    } else {
      return '';
    }
  }

  async start(): Promise<void> {
    // Stop any existing heartbeat
    this.stop();

    // Set initial presence
    this.updateUserPresence({forceUpdate: true});

    // Populate initial connection state
    // @ts-ignore - connectionState exists but may not be in type definitions
    this.isConnected = this.sdk.convexClient.connectionState().isWebSocketConnected;

    // Check connection interval
    this.testConnectionInterval = setInterval(() => {
      this.testConnection();
    }, this.TEST_CONNECTION_INTERVAL_MS);

    // Send heartbeat interval
    this.sendHeartbeatInterval = setInterval(() => {
      this.trySendHeartbeat();
    }, this.SEND_HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.sendHeartbeatInterval !== null) {
      clearInterval(this.sendHeartbeatInterval);
      this.sendHeartbeatInterval = null;
    }
    if (this.testConnectionInterval !== null) {
      clearInterval(this.testConnectionInterval);
      this.testConnectionInterval = null;
    }
  }

  async updateUserPresence(data?: Record<string, any>): Promise<boolean> {
    try {
      const dataToSend = data ?? {forceUpdate: true};
      await this.sdk.convexClient.mutation(api.presence.heartbeat, { data: dataToSend });
      return true;
    } catch (error) {
      this.sdk.logger.error(`Error updating presence: ${error}`);
      return false;
    }
  }

  async endUserPresence(): Promise<void> {
    await this.sdk.convexClient.mutation(api.presence.endUserPresence, {});
  }

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
        // Update presence in case it expired while we were disconnected
        this.updateUserPresence({forceUpdate: true});
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

  private async trySendHeartbeat(): Promise<void> {
    // Single-flight: don't send a new heartbeat if one is already in progress
    if (this.isHeartbeatInProgress) {
      return;
    }

    this.isHeartbeatInProgress = true;
    try {
      await this.sdk.convexClient.mutation(api.presence.heartbeat, {});
    } catch (error) {
      // Don't log every heartbeat error to avoid spam
      // The connection state polling will handle disconnection notification
    } finally {
      this.isHeartbeatInProgress = false;
    }
  }

  isCurrentlyConnected(): boolean {
    return this.isConnected;
  }
}

