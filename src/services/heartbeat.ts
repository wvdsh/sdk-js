/**
 * Heartbeat service
 *
 * Polls connection state and allows the game to update rich user presence
 * Lets the game know if backend connection ever changes.
 * Lets the game update userPresence in the backend
 */

import {
  api,
  DeviceFingerprint,
  HEARTBEAT,
  IFRAME_MESSAGE_TYPE
} from "@wvdsh/api";
import { WavedashEvents } from "../events";
import type { ConnectionState } from "convex/browser";
import type { BackendConnectionPayload } from "../types";
import { WavedashManager } from "./manager";
import type { WavedashSDK } from "../index";

export class HeartbeatManager extends WavedashManager {
  private deviceFingerprint: DeviceFingerprint | undefined = undefined;
  // Resolves once the parent has answered the device fingerprint request
  // (or we've given up on it). Always resolves — never rejects. Best-effort:
  // the backend stamps whatever fingerprint is present on the first heartbeat
  // into the gameplaySession metadata, so we delay the first tick until this
  // settles, but an empty fingerprint is acceptable.
  private deviceFingerprintReady: Promise<void>;
  private testConnectionInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private isConnected: boolean = false;
  private sentDisconnectedEvent: boolean = false;
  private disconnectedAt: number | null = null;
  private lastHeartbeatTime: number = 0;
  private heartbeatInFlight: boolean = false;
  private isFirstTick: boolean = true;
  private readonly TEST_CONNECTION_INTERVAL_MS = 1_000;
  private readonly DISCONNECTED_TIMEOUT_MS = 90_000;

  constructor(sdk: WavedashSDK) {
    super(sdk);

    this.isConnected =
      this.sdk.convexClient.client.connectionState().isWebSocketConnected;

    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    this.deviceFingerprintReady = this.sdk.iframeMessenger
      .requestFromParent(IFRAME_MESSAGE_TYPE.GET_DEVICE_FINGERPRINT)
      .then((fingerprint) => {
        this.deviceFingerprint = fingerprint;
      })
      // Required catch handler so this.deviceFingerprintReady always resolves
      .catch(() => {});
  }

  /** Start heartbeat and connection-check intervals */
  start(): void {
    if (!this.sdk.gameLoaded) {
      return;
    }

    // Stop any existing intervals before starting fresh
    this.stop();

    if (this.isFirstTick) {
      // Defer the very first heartbeat until the device fingerprint has
      // arrived from the parent
      void this.deviceFingerprintReady.then(() => {
        // isFirstTick is flipped to false by tickHeartbeat the first time it
        // runs, so repeat start() calls during the pending window all queue
        // a callback but only the first to execute does any work.
        if (!this.sdk.gameLoaded || !this.isFirstTick) return;
        this.tickHeartbeat();
      });
    } else {
      this.tickHeartbeat();
    }

    this.heartbeatInterval = setInterval(() => {
      this.tickHeartbeat();
    }, HEARTBEAT.CLIENT_INTERVAL_MS);

    this.testConnectionInterval = setInterval(() => {
      this.testConnection();
    }, this.TEST_CONNECTION_INTERVAL_MS);
  }

  /** Stop heartbeat and connection-check intervals */
  stop(): void {
    if (this.heartbeatInterval !== null) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.testConnectionInterval !== null) {
      clearInterval(this.testConnectionInterval);
      this.testConnectionInterval = null;
    }
  }

  /** Full teardown — stops intervals and removes all listeners */
  destroy(): void {
    this.stop();
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
  }

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      this.start();
    } else {
      this.stop();
    }
  };

  private tickHeartbeat(): void {
    const timeSinceLastHeartbeat = Date.now() - this.lastHeartbeatTime;
    const needsReestablish =
      this.isFirstTick ||
      timeSinceLastHeartbeat >= HEARTBEAT.CLIENT_REESTABLISH_THRESHOLD_MS;
    this.isFirstTick = false;

    if (needsReestablish) {
      this.sendHeartbeat(true);
    } else if (
      timeSinceLastHeartbeat >=
      HEARTBEAT.CLIENT_INTERVAL_MS - HEARTBEAT.CLIENT_GRACE_MS
    ) {
      this.sendHeartbeat(false);
    }
  }

  private sendHeartbeat(reestablish: boolean): void {
    if (!reestablish && this.heartbeatInFlight) return;
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
        this.sentDisconnectedEvent = false;
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.BACKEND_CONNECTED,
          connection
        );
      } else if (!this.isConnected && wasConnected) {
        // First tick of disconnection - notify reconnecting
        this.disconnectedAt = Date.now();
        this.sdk.logger.warn(
          "Backend disconnected - attempting to reconnect..."
        );
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.BACKEND_RECONNECTING,
          connection
        );
      } else if (!this.isConnected && !wasConnected) {
        // Still disconnected
        // After threshold, notify as truly disconnected
        if (
          this.disconnectedAt &&
          !this.sentDisconnectedEvent &&
          Date.now() - this.disconnectedAt > this.DISCONNECTED_TIMEOUT_MS
        ) {
          this.sdk.gameEventManager.notifyGame(
            WavedashEvents.BACKEND_DISCONNECTED,
            connection
          );
          this.sentDisconnectedEvent = true;
        }
      } else if (this.isConnected && wasConnected) {
        // Still connected
        this.disconnectedAt = null;
        this.sentDisconnectedEvent = false;
      }
    } catch (error) {
      this.sdk.logger.error("Error testing connection:", error);
    }
  }

  isCurrentlyConnected(): boolean {
    return this.isConnected;
  }
}
