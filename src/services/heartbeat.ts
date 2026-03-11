/**
 * Heartbeat service
 *
 * Polls connection state and allows the game to update rich user presence
 * Lets the game know if backend connection ever changes.
 * Lets the game update userPresence in the backend
 */

import { api, DeviceFingerprint, HEARTBEAT } from "@wvdsh/types";
import type { WavedashSDK } from "../index";
import { Signals } from "../signals";
import type { ConnectionState } from "convex/browser";
import type { BackendConnectionPayload } from "../types";

export class HeartbeatManager {
  private sdk: WavedashSDK;
  private deviceFingerprint: DeviceFingerprint | undefined = undefined;
  private testConnectionInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected: boolean = false;
  private sentDisconnectedSignal: boolean = false;
  private disconnectedAt: number | null = null;
  private lastHeartbeatTime: number = 0;
  private heartbeatInFlight: boolean = false;
  private isFirstTick: boolean = true;
  private readonly TEST_CONNECTION_INTERVAL_MS = 1_000;
  private readonly DISCONNECTED_TIMEOUT_MS = 90_000;

  constructor(sdk: WavedashSDK, deviceFingerprint?: DeviceFingerprint) {
    this.sdk = sdk;
    this.deviceFingerprint = deviceFingerprint;
  }

  start(): void {
    // Stop any existing heartbeat
    this.stop();

    // Populate initial connection state
    this.isConnected =
      this.sdk.convexClient.client.connectionState().isWebSocketConnected;

    // Let the backend know we've started the game
    this.updateUserPresence();

    // Start periodic heartbeat
    this.isFirstTick = true;
    this.tickHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.tickHeartbeat();
    }, HEARTBEAT.CLIENT_INTERVAL_MS);

    // Check connection interval
    this.testConnectionInterval = setInterval(() => {
      this.testConnection();
    }, this.TEST_CONNECTION_INTERVAL_MS);

    // Listen for visibility changes
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  stop(): void {
    if (this.testConnectionInterval !== null) {
      clearInterval(this.testConnectionInterval);
      this.testConnectionInterval = null;
    }
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      // Resume heartbeats
      this.tickHeartbeat();
      this.heartbeatInterval = setInterval(() => {
        this.tickHeartbeat();
      }, HEARTBEAT.CLIENT_INTERVAL_MS);

      // Resume connection monitor
      this.testConnectionInterval = setInterval(() => {
        this.testConnection();
      }, this.TEST_CONNECTION_INTERVAL_MS);
    } else {
      // Pause all intervals
      if (this.heartbeatInterval !== null) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
      if (this.testConnectionInterval !== null) {
        clearInterval(this.testConnectionInterval);
        this.testConnectionInterval = null;
      }
    }
  };

  private tickHeartbeat(): void {
    const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatTime;
    const needsReestablish =
      this.isFirstTick ||
      this.lastHeartbeatTime === 0 ||
      timeSinceLastHeartbeat >= HEARTBEAT.CLIENT_REESTABLISH_THRESHOLD_MS;
    this.isFirstTick = false;

    if (needsReestablish) {
      this.sendHeartbeat(true);
    } else if (
      !this.heartbeatInFlight &&
      timeSinceLastHeartbeat >=
        HEARTBEAT.CLIENT_INTERVAL_MS - HEARTBEAT.CLIENT_GRACE_MS
    ) {
      this.sendHeartbeat(false);
    }
  }

  private sendHeartbeat(reestablish: boolean): void {
    if (this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;

    this.sdk.convexClient
      .mutation(api.sdk.presence.heartbeat, {
        ...(reestablish ? { data: { forceUpdate: true } } : {}),
        deviceFingerprint: this.deviceFingerprint
      })
      .then((accepted: boolean) => {
        if (accepted) {
          this.lastHeartbeatTime = Date.now();
        }
      })
      .catch((error: unknown) => {
        this.sdk.logger.error(`Heartbeat failed: ${error}`);
      })
      .finally(() => {
        this.heartbeatInFlight = false;
      });
  }

  /**
   * Updates user presence in the backend
   * @param data - Data to send to the backend
   * @returns true if the presence was updated successfully
   */
  async updateUserPresence(data?: Record<string, unknown>): Promise<boolean> {
    try {
      // Add a default value to guarantee that the presence is updated
      const dataToSend = data ?? { forceUpdate: true };
      await this.sdk.convexClient.mutation(api.sdk.presence.heartbeat, {
        data: dataToSend,
        deviceFingerprint: this.deviceFingerprint
      });
      return true;
    } catch (error) {
      this.sdk.logger.error(`Error updating presence: ${error}`);
      return false;
    }
  }

  /**
   * Tests the connection to the backend
   */
  private testConnection(): void {
    try {
      // Check local connection state
      const wasConnected = this.isConnected;
      const state: ConnectionState =
        this.sdk.convexClient.client.connectionState() as ConnectionState;
      this.isConnected = navigator.onLine && state.isWebSocketConnected;
      const connection: BackendConnectionPayload = {
        isConnected: this.isConnected,
        hasEverConnected: state.hasEverConnected,
        connectionCount: state.connectionCount,
        connectionRetries: state.connectionRetries
      };

      // Handle connection state changes
      if (this.isConnected && !wasConnected) {
        // Reconnected
        this.disconnectedAt = null;
        this.sentDisconnectedSignal = false;
        this.sdk.notifyGame(Signals.BACKEND_CONNECTED, connection);
      } else if (!this.isConnected && wasConnected) {
        // First tick of disconnection - notify reconnecting
        this.disconnectedAt = Date.now();
        this.sdk.logger.warn(
          "Backend disconnected - attempting to reconnect..."
        );
        this.sdk.notifyGame(Signals.BACKEND_RECONNECTING, connection);
      } else if (!this.isConnected && !wasConnected) {
        // Still disconnected
        // After threshold, notify as truly disconnected
        if (
          this.disconnectedAt &&
          !this.sentDisconnectedSignal &&
          Date.now() - this.disconnectedAt > this.DISCONNECTED_TIMEOUT_MS
        ) {
          this.sdk.notifyGame(Signals.BACKEND_DISCONNECTED, connection);
          this.sentDisconnectedSignal = true;
        }
      } else if (this.isConnected && wasConnected) {
        // Still connected
        this.disconnectedAt = null;
        this.sentDisconnectedSignal = false;
      }
    } catch (error) {
      this.sdk.logger.error("Error testing connection:", error);
    }
  }

  isCurrentlyConnected(): boolean {
    return this.isConnected;
  }
}
