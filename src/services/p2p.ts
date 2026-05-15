/**
 * P2P networking service
 *
 * Handles WebRTC peer-to-peer connections for lobbies
 */

import type { FunctionReturnType } from "convex/server";
import type {
  Id,
  P2PPeer,
  P2PConnection,
  P2PMessage,
  P2PConfig,
  P2PConnectionEstablishedPayload,
  P2PConnectionFailedPayload,
  P2PPeerDisconnectedPayload,
  P2PPeerReconnectingPayload,
  P2PPeerReconnectedPayload,
  P2PPacketDroppedPayload,
  P2PPacketDropReason
} from "../types";
import { WavedashEvents } from "../events";
import type { WavedashSDK } from "../index";
import { WavedashManager } from "./manager";
import { logger } from "../utils/logger";
import { api, P2P_SIGNALING_MESSAGE_TYPE, SDKUser } from "@wvdsh/api";

// Internal P2P signaling/TURN types — not part of the public SDK surface.
type P2PTurnCredentials = FunctionReturnType<
  typeof api.sdk.turnCredentials.getOrCreate
>;

type P2PSignalingMessage = Omit<
  FunctionReturnType<typeof api.sdk.p2pSignaling.getSignalingMessages>[0],
  "data"
> & {
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
};

// Default P2P configuration
const DEFAULT_P2P_CONFIG: Required<P2PConfig> = {
  enableReliableChannel: true,
  enableUnreliableChannel: true,
  messageSize: 2048,
  maxIncomingMessages: 1024
};

export class P2PManager extends WavedashManager {
  private config: Required<P2PConfig>;
  private currentConnection: P2PConnection | null = null;

  // WebRTC connection state
  private peerConnections = new Map<Id<"users">, RTCPeerConnection>();
  private reliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private unreliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private pendingIceCandidates = new Map<Id<"users">, RTCIceCandidateInit[]>();

  // ICE restart tracking
  private iceRestartAttempts = new Map<Id<"users">, number>();
  private iceRestartInProgress = new Set<Id<"users">>();
  private readonly MAX_ICE_RESTART_ATTEMPTS = 3;

  // Peers for which we've emitted P2P_PEER_RECONNECTING but not yet RECONNECTED.
  // Tracked on both active and passive sides so reconnect events stay symmetric
  // regardless of which peer drives the ICE restart.
  private reconnectingPeers = new Set<Id<"users">>();

  // Peers for which we've emitted P2P_CONNECTION_ESTABLISHED. Prevents duplicate
  // emissions if both data channels happen to open concurrently, and is cleared
  // on peer disconnect so a rejoining peer gets a fresh ESTABLISHED event.
  private establishedPeers = new Set<Id<"users">>();

  // One packet-drop tracker per distinct problem, keyed by
  // `${direction}:${channel}:${reason}` so e.g. send-side oversize vs
  // receive-side queue-full on the same channel don't coalesce into each
  // other's events.
  //
  // Policy: the first drop on an idle tracker fires an event immediately so
  // games learn about issues with no latency. Subsequent drops within
  // PACKET_DROP_WINDOW_MS are coalesced into a single event fired at the end
  // of the window. If drops stop, the timer clears and the tracker returns
  // to idle. Bounds event rate at ~1/window/tracker even under sustained
  // overload while staying responsive for sparse drops.
  private packetDropTrackers = new Map<
    string,
    {
      channel: number;
      direction: "SEND" | "RECEIVE";
      reason: P2PPacketDropReason;
      pendingCount: number;
      windowTimer: ReturnType<typeof setTimeout> | null;
      droppedTotal: number;
    }
  >();
  private readonly PACKET_DROP_WINDOW_MS = 500;

  // TURN server credentials
  private turnCredentials: P2PTurnCredentials | null = null;
  private turnCredentialsInitPromise: Promise<void> | null = null;

  // Signaling state
  private unsubscribeFromSignalingMessages: (() => void) | null = null;
  private processedSignalingMessages = new Set<string>();
  private pendingProcessedMessageIds = new Set<Id<"p2pSignalingMessages">>();

  // Initialization lock to prevent duplicate concurrent initialization for the same lobby
  private initializationInProgress: Promise<P2PConnection> | null = null;
  private initializationLobbyId: Id<"lobbies"> | null = null;

  // Signaling subscription readiness tracking
  private signalingSubscriptionReady: Promise<void> | null = null;
  private signalingSubscriptionReadyResolver: (() => void) | null = null;

  // Message queues - one per channel for performance
  // Only incoming queue is used (P2P network → Game engine)
  // Note: Using regular ArrayBuffer since all JS runs on main thread (no Web Workers)
  // Game engines call into JS synchronously, so SharedArrayBuffer + Atomics just adds overhead without any benefit
  private channelQueues = new Map<
    number,
    {
      buffer: ArrayBuffer;
      writeIndex: number;
      readIndex: number;
      messageCount: number;
      incomingDataView: Uint8Array;
    }
  >();

  private readonly MESSAGE_SLOT_HEADER_SIZE = 4; // Size prefix at start of each message slot
  private readonly MAX_CHANNELS = 8; // Maximum number of channels to support

  // Binary message formats
  //
  // Wire format (what actually travels over the RTCDataChannel):
  //   [channel(1)][payload(...)]
  // Things NOT on the wire and why:
  //   - fromUserId: inferred from the RTCDataChannel the bytes arrive on
  //   - dataLength: WebRTC DataChannels preserve message boundaries, length can be inferred from payload size
  //
  // In-memory slot format (what the ring buffer + game engines consume):
  //   [fromUserId(32)][channel(4)][dataLength(4)][payload(...)]
  // On receive we prepend the authenticated peer userId and re-insert
  // dataLength + a widened channel so engine-side decoders (Unity
  // DecodeP2PPacket, Godot _decode_p2p_packet) stay byte-compatible.
  private readonly USERID_SIZE = 32; // TODO: Switch to int handles so this can be 4 bytes instead of 32
  private readonly CHANNEL_SIZE = 4; // Slot-side channel width (engine decoders expect 4 bytes)
  private readonly DATALENGTH_SIZE = 4;
  // In-memory slot offsets
  private readonly CHANNEL_OFFSET = this.USERID_SIZE; // Channel comes after fromUserId
  private readonly DATALENGTH_OFFSET = this.USERID_SIZE + this.CHANNEL_SIZE;
  private readonly PAYLOAD_OFFSET =
    this.USERID_SIZE + this.CHANNEL_SIZE + this.DATALENGTH_SIZE;
  // Wire offsets (just a 1-byte channel header)
  private readonly WIRE_CHANNEL_SIZE = 1;
  private readonly WIRE_CHANNEL_OFFSET = 0;
  private readonly WIRE_PAYLOAD_OFFSET = this.WIRE_CHANNEL_SIZE;

  // Limits for configurable sizing
  // 64KB - safe cross-browser WebRTC floor, avoids SCTP fragmentation
  private static readonly MAX_MESSAGE_SIZE = 64 * 1024;
  private static readonly MEMORY_WARNING_THRESHOLD_BYTES = 128 * 1024 * 1024;

  // Configurable sizing (set in init() from P2PConfig)
  private QUEUE_SIZE!: number;
  private MESSAGE_SIZE!: number;
  private MAX_PAYLOAD_SIZE!: number;

  // Pre-allocated buffer for outgoing messages to avoid repeated allocations
  // Game engine writes payload here, then calls sendP2PMessage
  private outgoingMessageBuffer!: Uint8Array;
  private textEncoder: TextEncoder = new TextEncoder();
  private textDecoder: TextDecoder = new TextDecoder();

  private initialized = false;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.config = { ...DEFAULT_P2P_CONFIG };
  }

  destroy(): void {
    this.disconnectP2P();
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      this.init();
    }
  }

  init(config?: Partial<P2PConfig>): void {
    if (this.initialized && !config) return;
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };

    const minMessageSize =
      this.MESSAGE_SLOT_HEADER_SIZE + this.PAYLOAD_OFFSET + 1;
    const rawMessageSize = this.config.messageSize;
    const rawQueueSize = this.config.maxIncomingMessages;

    if (rawMessageSize < minMessageSize) {
      throw new Error(
        `P2P messageSize must be at least ${minMessageSize} bytes (got ${rawMessageSize})`
      );
    }
    if (rawMessageSize > P2PManager.MAX_MESSAGE_SIZE) {
      console.warn(
        `P2P messageSize ${rawMessageSize} exceeds max ${P2PManager.MAX_MESSAGE_SIZE}, clamping to ${P2PManager.MAX_MESSAGE_SIZE}`
      );
    }
    if (rawQueueSize < 1) {
      throw new Error(
        `P2P maxIncomingMessages must be at least 1 (got ${rawQueueSize})`
      );
    }

    this.MESSAGE_SIZE = Math.min(rawMessageSize, P2PManager.MAX_MESSAGE_SIZE);
    this.QUEUE_SIZE = rawQueueSize;
    this.MAX_PAYLOAD_SIZE =
      this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE - this.PAYLOAD_OFFSET;
    this.outgoingMessageBuffer = new Uint8Array(this.MAX_PAYLOAD_SIZE);

    // Ring buffers are allocated lazily per channel on first receive (see
    // createChannelQueue), so games that don't use P2P pay nothing here.
    // Warn about worst-case footprint if all channels end up in use.
    const worstCaseMemory =
      this.MESSAGE_SIZE * this.QUEUE_SIZE * this.MAX_CHANNELS;
    if (worstCaseMemory > P2PManager.MEMORY_WARNING_THRESHOLD_BYTES) {
      console.warn(
        `P2P ring buffer memory could reach ${(worstCaseMemory / 1024 / 1024).toFixed(1)}MB ` +
          `if all ${this.MAX_CHANNELS} channels are used ` +
          `(messageSize=${this.MESSAGE_SIZE} x maxIncomingMessages=${this.QUEUE_SIZE} per channel). ` +
          `Consider reducing maxIncomingMessages if memory is a concern.`
      );
    }

    this.initialized = true;
  }

  // ================
  // Connection Setup
  // ================

  async initializeP2PForCurrentLobby(
    lobbyId: Id<"lobbies">,
    members: SDKUser[]
  ): Promise<P2PConnection> {
    this.ensureInitialized();

    // If we already have a connection for this lobby, update it
    if (this.currentConnection && this.currentConnection.lobbyId === lobbyId) {
      return this.updateP2PConnection(members);
    }

    // If initialization is already in progress for this lobby, wait for it
    if (
      this.initializationInProgress &&
      this.initializationLobbyId === lobbyId
    ) {
      logger.debug(
        "P2P initialization already in progress, waiting..."
      );
      await this.initializationInProgress;
      // After waiting, update with potentially new members
      if (this.currentConnection) {
        return this.updateP2PConnection(members);
      }
    }

    // Start new initialization with lock
    this.initializationLobbyId = lobbyId;
    this.initializationInProgress = this.doInitializeP2P(lobbyId, members);

    try {
      return await this.initializationInProgress;
    } finally {
      this.initializationInProgress = null;
      this.initializationLobbyId = null;
    }
  }

  /**
   * Internal method that performs the actual P2P initialization.
   * Called by initializeP2PForCurrentLobby with proper locking.
   */
  private async doInitializeP2P(
    lobbyId: Id<"lobbies">,
    members: SDKUser[]
  ): Promise<P2PConnection> {
    const connection: P2PConnection = {
      lobbyId,
      peers: {}
    };

    members.forEach((member) => {
      if (member.id !== this.sdk.getUserId()) {
        connection.peers[member.id] = {
          userId: member.id,
          username: member.username
        };
      }
    });

    this.currentConnection = connection;
    await this.establishWebRTCConnections(connection);
    return connection;
  }

  /**
   * Get ICE servers, initializing TURN credentials if necessary.
   * Uses a promise to debounce concurrent calls and prevent race conditions.
   */
  private async getIceServers(): Promise<RTCIceServer[] | null> {
    const CREDENTIALS_EXPIRY_BUFFER_MS = 1000 * 60 * 60; // 1 hour buffer

    // If already initialized and not expired, return cached
    if (
      this.turnCredentials &&
      this.turnCredentials.expiresAt > Date.now() + CREDENTIALS_EXPIRY_BUFFER_MS
    ) {
      return this.turnCredentials.iceServers;
    }

    // If initialization is already in progress, wait for it and return cached
    if (this.turnCredentialsInitPromise) {
      await this.turnCredentialsInitPromise;
      return this.turnCredentials?.iceServers ?? null;
    }

    // Start initialization
    this.turnCredentialsInitPromise = (async () => {
      try {
        this.turnCredentials = await this.sdk.convexClient.action(
          api.sdk.turnCredentials.getOrCreate,
          {}
        );
      } finally {
        this.turnCredentialsInitPromise = null;
      }
    })();

    await this.turnCredentialsInitPromise;
    return this.turnCredentials?.iceServers ?? null;
  }

  private async updateP2PConnection(
    members: SDKUser[]
  ): Promise<P2PConnection> {
    if (!this.currentConnection) {
      throw new Error("No existing P2P connection to update");
    }

    logger.debug("Updating P2P connection with new member list");

    const currentPeerUserIds = new Set(
      Object.keys(this.currentConnection.peers)
    );
    currentPeerUserIds.add(this.sdk.getUserId());
    const newPeerUserIds = new Set(members.map((member) => member.id));

    // Find new users who joined
    const connectionsToCreate: Id<"users">[] = [];
    for (const member of members) {
      if (member.id === this.sdk.getUserId()) continue;

      const existingPeer = this.currentConnection.peers[member.id];
      if (existingPeer) {
        // Update username if it was empty (from on-demand peer creation)
        if (!existingPeer.username && member.username) {
          existingPeer.username = member.username;
        }
      } else {
        logger.debug(
          `Adding new peer: ${member.username} (${member.id})`
        );

        // Add new peer to connection
        this.currentConnection.peers[member.id] = {
          userId: member.id,
          username: member.username
        };
        connectionsToCreate.push(member.id);
      }
    }

    // Create connections to new peers only
    if (connectionsToCreate.length > 0) {
      const currentUserId = this.sdk.getUserId();
      const connectionPromises = connectionsToCreate.map((userId) => {
        const shouldCreateChannels = currentUserId < userId;
        logger.debug(
          `Creating connection to new peer ${userId}, shouldCreateChannels: ${shouldCreateChannels}`
        );
        return this.createPeerConnection(
          userId,
          this.currentConnection!,
          shouldCreateChannels
        );
      });
      await Promise.all(connectionPromises);

      // Initiate offers to new peers where we have lower userId
      const peersToInitiate = connectionsToCreate.filter(
        (userId) => currentUserId < userId
      );

      if (peersToInitiate.length > 0) {
        const offerPromises = peersToInitiate.map((userId) => {
          logger.debug(
            `Initiating offer to new peer ${userId} (lower userId rule)`
          );
          return this.createOfferToPeer(userId);
        });

        await Promise.all(offerPromises);
        logger.debug(
          `Initiated ${offerPromises.length} offers to new peers`
        );
      }
    }

    // Clean up connections to users who left
    for (const userId of Object.keys(
      this.currentConnection.peers
    ) as Id<"users">[]) {
      if (!newPeerUserIds.has(userId)) {
        const peer = this.currentConnection.peers[userId];
        logger.debug(`Peer left: ${peer.username} (${userId})`);

        // Clean up WebRTC resources
        const pc = this.peerConnections.get(userId);
        if (pc) {
          pc.close();
          this.peerConnections.delete(userId);
        }
        this.reliableChannels.delete(userId);
        this.unreliableChannels.delete(userId);
        this.pendingIceCandidates.delete(userId);
        this.iceRestartAttempts.delete(userId);
        this.iceRestartInProgress.delete(userId);
        this.reconnectingPeers.delete(userId);
        this.establishedPeers.delete(userId);

        // Remove from peer list
        delete this.currentConnection.peers[userId];
      }
    }

    return this.currentConnection;
  }

  private async establishWebRTCConnections(
    connection: P2PConnection
  ): Promise<void> {
    // Subscribe to real-time signaling message updates
    this.subscribeToSignalingMessages(connection);

    // Wait for the signaling subscription to be ready before proceeding
    // This ensures we can receive answers to our offers
    if (this.signalingSubscriptionReady) {
      await this.signalingSubscriptionReady;
      logger.debug("Signaling subscription confirmed ready");
    }

    // Establish WebRTC connections (creates offers)
    await this.establishPeerConnections(connection);
  }

  private subscribeToSignalingMessages(connection: P2PConnection): void {
    // Create a promise that resolves when we receive the first subscription callback
    // This indicates the subscription is active and ready to receive messages
    this.signalingSubscriptionReady = new Promise((resolve) => {
      this.signalingSubscriptionReadyResolver = resolve;
    });

    let firstCallbackReceived = false;

    // Subscribe to real-time signaling message updates
    this.unsubscribeFromSignalingMessages = this.sdk.convexClient.onUpdate(
      api.sdk.p2pSignaling.getSignalingMessages,
      { lobbyId: connection.lobbyId },
      (messages) => {
        // Mark subscription as ready on first callback
        if (!firstCallbackReceived) {
          firstCallbackReceived = true;
          this.signalingSubscriptionReadyResolver?.();
          this.signalingSubscriptionReadyResolver = null;
        }

        if (messages) {
          this.processSignalingMessages(messages, connection);
        }
      }
    );
  }

  private stopSignalingMessageSubscription(): void {
    if (this.unsubscribeFromSignalingMessages !== null) {
      this.unsubscribeFromSignalingMessages();
      this.unsubscribeFromSignalingMessages = null;
    }
  }

  private async processSignalingMessages(
    messages: P2PSignalingMessage[],
    connection: P2PConnection
  ): Promise<void> {
    if (messages.length === 0) return;

    const newMessageIds: Id<"p2pSignalingMessages">[] = [];
    const messagesToProcess: P2PSignalingMessage[] = [];

    // Filter out messages we've already processed or are pending processing
    for (const message of messages) {
      if (
        !this.processedSignalingMessages.has(message._id) &&
        !this.pendingProcessedMessageIds.has(message._id)
      ) {
        messagesToProcess.push(message);
      }
      // Always include in batch to mark as processed
      newMessageIds.push(message._id);
    }

    // Process only new messages
    for (const message of messagesToProcess) {
      this.pendingProcessedMessageIds.add(message._id);

      try {
        await this.handleSignalingMessage(message, connection);
        this.processedSignalingMessages.add(message._id);
      } catch (error) {
        logger.error("Error handling signaling message:", error);
      }
    }

    // Mark all messages as processed in batch
    if (newMessageIds.length > 0) {
      try {
        await this.sdk.convexClient.mutation(
          api.sdk.p2pSignaling.markSignalingMessagesProcessed,
          { messageIds: newMessageIds }
        );

        // Remove from pending set after successful batch processing
        for (const messageId of newMessageIds) {
          this.pendingProcessedMessageIds.delete(messageId);
        }
      } catch (error) {
        logger.error(
          "Failed to mark signaling messages as processed:",
          error
        );
        // Remove from pending set even on failure to avoid permanent blocking
        for (const messageId of newMessageIds) {
          this.pendingProcessedMessageIds.delete(messageId);
        }
      }
    }
  }

  private async handleSignalingMessage(
    message: P2PSignalingMessage,
    connection: P2PConnection
  ): Promise<void> {
    // Skip messages from ourselves
    if (message.fromUserId === this.sdk.getUserId()) {
      return;
    }

    const remoteUserId = message.fromUserId;

    // If we receive an OFFER from a user we don't have a peer connection for yet,
    // create one on-demand. This handles the race condition where the remote peer
    // sends an offer before our updateP2PConnection has been called with them in the member list.
    if (!this.peerConnections.has(remoteUserId)) {
      if (message.messageType === P2P_SIGNALING_MESSAGE_TYPE.OFFER) {
        logger.debug(
          `Received offer from ${remoteUserId} before peer connection exists, creating on-demand`
        );

        // Add peer to connection if not already present
        if (!connection.peers[remoteUserId]) {
          connection.peers[remoteUserId] = {
            userId: remoteUserId,
            username: "" // Will be updated when member list arrives
          };
        }

        // Create peer connection (we're receiving the offer, so don't create channels)
        const success = await this.createPeerConnection(
          remoteUserId,
          connection,
          false // shouldCreateChannels = false, we'll receive them via ondatachannel
        );

        if (!success) {
          logger.error(
            `Failed to create on-demand peer connection for ${remoteUserId}`
          );
          return;
        }
      } else {
        // For non-OFFER messages, we need the peer connection to exist first
        logger.warn(
          `No peer connection for user ${remoteUserId}, dropping ${message.messageType} message`
        );
        return;
      }
    }

    const pc = this.peerConnections.get(remoteUserId)!;

    switch (message.messageType) {
      case P2P_SIGNALING_MESSAGE_TYPE.OFFER: {
        // Receiving an offer means peer is handling connection/restart - clear our restart state
        this.iceRestartInProgress.delete(remoteUserId);

        logger.debug(`Processing offer from peer ${remoteUserId}:`);

        await pc.setRemoteDescription(
          new RTCSessionDescription(message.data as RTCSessionDescriptionInit)
        );

        // Flush any buffered ICE candidates now that remote description is set
        await this.flushPendingIceCandidates(remoteUserId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        logger.debug(
          `  Answer created, waiting for ondatachannel events...`
        );

        // Convert RTCSessionDescription to plain object for Convex
        const answerData = {
          type: answer.type,
          sdp: answer.sdp
        };

        await this.sendSignalingMessage(remoteUserId, {
          type: P2P_SIGNALING_MESSAGE_TYPE.ANSWER,
          data: answerData
        });
        break;
      }

      case P2P_SIGNALING_MESSAGE_TYPE.ANSWER:
        await pc.setRemoteDescription(
          new RTCSessionDescription(message.data as RTCSessionDescriptionInit)
        );

        // Flush any buffered ICE candidates now that remote description is set
        await this.flushPendingIceCandidates(remoteUserId, pc);
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE: {
        const iceData = message.data as RTCIceCandidateInit;
        // Buffer candidates if remote description not yet set (race condition fix)
        if (!pc.remoteDescription) {
          const pending = this.pendingIceCandidates.get(remoteUserId) || [];
          pending.push(iceData);
          this.pendingIceCandidates.set(remoteUserId, pending);
          logger.debug(
            `Buffered ICE candidate for ${remoteUserId} (remote description not yet set, ${pending.length} buffered)`
          );
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(iceData));
        }
        break;
      }

      default:
        logger.warn(
          "Unknown signaling message type:",
          message.messageType
        );
    }
  }

  /**
   * Flush any buffered ICE candidates for a peer after remote description is set.
   * This handles the race condition where ICE candidates arrive before the offer/answer.
   */
  private async flushPendingIceCandidates(
    remoteUserId: Id<"users">,
    pc: RTCPeerConnection
  ): Promise<void> {
    const pending = this.pendingIceCandidates.get(remoteUserId);
    if (pending && pending.length > 0) {
      for (const candidate of pending) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          logger.warn(
            `Failed to add buffered ICE candidate for ${remoteUserId}:`,
            error
          );
        }
      }
      this.pendingIceCandidates.delete(remoteUserId);
    }
  }

  private async establishPeerConnections(
    connection: P2PConnection
  ): Promise<void> {
    logger.debug("Establishing WebRTC connections to peers...");

    const currentUserId = this.sdk.getUserId();
    const connectionPromises: Promise<boolean>[] = [];

    // Create peer connections to all other peers
    (Object.entries(connection.peers) as [Id<"users">, P2PPeer][]).forEach(
      ([userId, peer]) => {
        const shouldCreateChannels = currentUserId < userId;
        logger.debug(
          `Creating connection to peer ${userId} (${peer.username}), shouldCreateChannels: ${shouldCreateChannels}`
        );
        connectionPromises.push(
          this.createPeerConnection(userId, connection, shouldCreateChannels)
        );
      }
    );

    // Wait for all connections to be created first
    await Promise.all(connectionPromises);

    // Initiate offers to peers where we have lower userId
    const peersToInitiate = (
      Object.keys(connection.peers) as Id<"users">[]
    ).filter((userId) => currentUserId < userId);

    if (peersToInitiate.length > 0) {
      const offerPromises = peersToInitiate.map((userId) => {
        logger.debug(
          `Initiating offer to peer ${userId} (lower userId rule)`
        );
        return this.createOfferToPeer(userId);
      });

      await Promise.all(offerPromises);
      logger.debug(
        `Created ${connectionPromises.length} peer connections and initiated ${offerPromises.length} offers`
      );
    } else {
      logger.debug(
        `Created ${connectionPromises.length} peer connections, no offers to initiate`
      );
    }
  }

  private async createOfferToPeer(remoteUserId: Id<"users">): Promise<void> {
    const pc = this.peerConnections.get(remoteUserId);
    if (!pc) {
      throw new Error(`No peer connection for user ${remoteUserId}`);
    }

    // Log channel states before creating offer
    const reliableChannel = this.reliableChannels.get(remoteUserId);
    const unreliableChannel = this.unreliableChannels.get(remoteUserId);
    logger.debug(`Creating offer to peer ${remoteUserId}:`);
    logger.debug(
      `  Reliable channel state: ${reliableChannel?.readyState || "none"}`
    );
    logger.debug(
      `  Unreliable channel state: ${unreliableChannel?.readyState || "none"}`
    );

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Convert RTCSessionDescription to plain object for Convex
    const offerData = {
      type: offer.type,
      sdp: offer.sdp
    };

    await this.sendSignalingMessage(remoteUserId, {
      type: P2P_SIGNALING_MESSAGE_TYPE.OFFER,
      data: offerData
    });
  }

  private async createPeerConnection(
    remoteUserId: Id<"users">,
    connection: P2PConnection,
    shouldCreateChannels: boolean = false
  ): Promise<boolean> {
    const iceServers = await this.getIceServers();
    if (!iceServers) {
      logger.error(
        `No ICE servers available for peer ${remoteUserId}`
      );
      this.sdk.gameEventManager.notifyGame(
        WavedashEvents.P2P_CONNECTION_FAILED,
        {
          userId: remoteUserId,
          username: connection.peers[remoteUserId]?.username || "",
          error: "No ICE servers available"
        } satisfies P2PConnectionFailedPayload
      );
      return false;
    }
    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      // Disable candidate pre-gathering - gather ICE candidates only after setLocalDescription()
      // This ensures proper sequencing and avoids race conditions at the cost of
      // slightly slower initial connection (more reliable)
      iceCandidatePoolSize: 0,
      // Allow all IP addresses (helpful for same-device testing)
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });

    // Only create data channels if this peer will initiate the offer
    if (shouldCreateChannels) {
      logger.debug(`Creating data channels for peer ${remoteUserId}`);

      if (this.config.enableReliableChannel) {
        const reliableChannel = pc.createDataChannel("reliable", {
          ordered: true,
          maxRetransmits: undefined // Full reliability, will retransmit until received
        });
        this.reliableChannels.set(remoteUserId, reliableChannel);
        this.setupDataChannelHandlers(
          reliableChannel,
          remoteUserId,
          "reliable"
        );
      }

      if (this.config.enableUnreliableChannel) {
        const unreliableChannel = pc.createDataChannel("unreliable", {
          ordered: false,
          maxRetransmits: 0 // No retransmits, will drop if not received
        });
        this.unreliableChannels.set(remoteUserId, unreliableChannel);
        this.setupDataChannelHandlers(
          unreliableChannel,
          remoteUserId,
          "unreliable"
        );
      }
    } else {
      logger.debug(
        `Will receive data channels from peer ${remoteUserId} via ondatachannel`
      );
    }

    // Set up peer connection event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Log candidate type for debugging
        const candidateType = event.candidate.candidate.includes("typ host")
          ? "host"
          : event.candidate.candidate.includes("typ srflx")
            ? "srflx (STUN)"
            : event.candidate.candidate.includes("typ relay")
              ? "relay (TURN)"
              : "unknown";

        logger.debug(
          `Peer ${remoteUserId} gathered ICE candidate: ${candidateType}`
        );
        logger.debug(`  Candidate: ${event.candidate.candidate}`);

        // Convert RTCIceCandidate to a plain object for Convex serialization
        const candidateData = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        };

        this.sendSignalingMessage(remoteUserId, {
          type: P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE,
          data: candidateData
        });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      logger.debug(
        `Received ${channel.label} data channel from peer ${remoteUserId}`
      );

      // Store the received channel in the appropriate map
      if (channel.label === "reliable") {
        this.reliableChannels.set(remoteUserId, channel);
      } else if (channel.label === "unreliable") {
        this.unreliableChannels.set(remoteUserId, channel);
      }

      this.setupDataChannelHandlers(
        channel,
        remoteUserId,
        channel.label as "reliable" | "unreliable"
      );
    };

    // Add connection state monitoring for debugging
    pc.onconnectionstatechange = () => {
      logger.debug(
        `Peer ${remoteUserId} connection state: ${pc.connectionState}`
      );
      if (pc.connectionState === "connected") {
        logger.debug(
          `  Peer ${remoteUserId} fully connected, expecting ondatachannel events now...`
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      logger.debug(
        `Peer ${remoteUserId} ICE connection state: ${pc.iceConnectionState}`
      );
      if (pc.iceConnectionState === "connected") {
        logger.debug(
          `  ICE connected to peer ${remoteUserId}, data channels should be available...`
        );
        // Reset restart state on successful connection
        this.iceRestartAttempts.delete(remoteUserId);
        this.iceRestartInProgress.delete(remoteUserId);

        // If we previously flagged this peer as reconnecting, notify the game
        // that it's back. Both sides (active and passive) see this transition.
        if (this.reconnectingPeers.delete(remoteUserId)) {
          const peer = this.currentConnection?.peers[remoteUserId];
          if (peer) {
            this.sdk.gameEventManager.notifyGame(
              WavedashEvents.P2P_PEER_RECONNECTED,
              {
                userId: peer.userId,
                username: peer.username
              } satisfies P2PPeerReconnectedPayload
            );
          }
        }
      } else if (pc.iceConnectionState === "failed") {
        // ICE connection failed - wait briefly before restarting to avoid
        // reacting to transient failures during network switches (Wi-Fi hiccups, etc.)
        logger.debug(
          `ICE connection to peer ${remoteUserId} failed, will retry in 500ms...`
        );

        // Notify the game that this peer is in a reconnecting state. Fired on
        // both sides of the connection so games get a symmetric signal even
        // though only one peer drives the ICE restart. Guarded so we only
        // emit once per disconnect/reconnect cycle.
        if (!this.reconnectingPeers.has(remoteUserId)) {
          this.reconnectingPeers.add(remoteUserId);
          const peer = this.currentConnection?.peers[remoteUserId];
          if (peer) {
            this.sdk.gameEventManager.notifyGame(
              WavedashEvents.P2P_PEER_RECONNECTING,
              {
                userId: peer.userId,
                username: peer.username
              } satisfies P2PPeerReconnectingPayload
            );
          }
        }

        setTimeout(() => {
          if (pc.iceConnectionState === "failed") {
            logger.warn(
              `ICE connection to peer ${remoteUserId} still failed after delay, attempting ICE restart...`
            );
            this.attemptIceRestart(remoteUserId, pc);
          }
        }, 500);
      } else if (pc.iceConnectionState === "disconnected") {
        // Disconnected state may recover on its own, but log it
        logger.debug(
          `ICE connection to peer ${remoteUserId} disconnected, may recover...`
        );
      }
    };

    pc.onicegatheringstatechange = () => {
      logger.debug(
        `Peer ${remoteUserId} ICE gathering state: ${pc.iceGatheringState}`
      );
    };

    this.peerConnections.set(remoteUserId, pc);
    return true;
  }

  /**
   * Attempt to restart ICE when connection fails.
   * Only the peer with the lower userId initiates the restart to avoid conflicts.
   */
  private async attemptIceRestart(
    remoteUserId: Id<"users">,
    pc: RTCPeerConnection
  ): Promise<void> {
    const currentUserId = this.sdk.getUserId();

    // Only the peer with lower userId initiates restart to avoid both sides restarting simultaneously
    if (currentUserId > remoteUserId) {
      logger.debug(
        `Waiting for peer ${remoteUserId} to initiate ICE restart (they have lower userId)`
      );
      return;
    }

    // Skip if restart already in progress for this peer
    if (this.iceRestartInProgress.has(remoteUserId)) {
      logger.debug(
        `ICE restart already in progress for peer ${remoteUserId}, skipping`
      );
      return;
    }

    // Check restart attempt count
    const attempts = this.iceRestartAttempts.get(remoteUserId) || 0;
    if (attempts >= this.MAX_ICE_RESTART_ATTEMPTS) {
      logger.error(
        `Max ICE restart attempts (${this.MAX_ICE_RESTART_ATTEMPTS}) reached for peer ${remoteUserId}, giving up`
      );
      // Clear reconnecting/established flags since we're reporting terminal
      // failure instead. Any future recovery for this peer will count as a
      // fresh ESTABLISHED.
      this.reconnectingPeers.delete(remoteUserId);
      this.establishedPeers.delete(remoteUserId);
      const peer = this.currentConnection?.peers[remoteUserId];
      if (peer) {
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.P2P_CONNECTION_FAILED,
          {
            userId: peer.userId,
            username: peer.username,
            error: "ICE restart failed after maximum attempts"
          } satisfies P2PConnectionFailedPayload
        );
      }
      // Close the pc so the remote peer's channels close too — otherwise the
      // passive peer (higher userId, which doesn't drive restarts) would be
      // left with P2P_PEER_RECONNECTING and no terminal event. The resulting
      // channel.onclose on both sides emits P2P_PEER_DISCONNECTED.
      pc.close();
      return;
    }

    this.iceRestartAttempts.set(remoteUserId, attempts + 1);
    this.iceRestartInProgress.add(remoteUserId);
    logger.debug(
      `ICE restart attempt ${attempts + 1}/${this.MAX_ICE_RESTART_ATTEMPTS} for peer ${remoteUserId}`
    );

    try {
      // Trigger ICE restart - this invalidates current ICE candidates and gathers new ones
      pc.restartIce();

      // Create and send a new offer with iceRestart flag
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);

      const offerData = {
        type: offer.type,
        sdp: offer.sdp
      };

      await this.sendSignalingMessage(remoteUserId, {
        type: P2P_SIGNALING_MESSAGE_TYPE.OFFER,
        data: offerData
      });

      logger.debug(`ICE restart offer sent to peer ${remoteUserId}`);
    } catch (error) {
      logger.error(
        `Failed to initiate ICE restart for peer ${remoteUserId}:`,
        error
      );
    }
  }

  private setupDataChannelHandlers(
    channel: RTCDataChannel,
    remoteUserId: Id<"users">,
    type: "reliable" | "unreliable"
  ): void {
    channel.onopen = () => {
      logger.debug(
        `${type} data channel opened with peer ${remoteUserId}`
      );

      // Check if this peer is now fully ready (both channels open if both are enabled).
      // Guarded so we only emit once per peer connection lifetime — the flag is
      // cleared on disconnect so a rejoining peer fires a fresh ESTABLISHED.
      if (
        this.isPeerReady(remoteUserId) &&
        !this.establishedPeers.has(remoteUserId)
      ) {
        this.establishedPeers.add(remoteUserId);
        const peer = this.currentConnection?.peers[remoteUserId];
        if (peer) {
          this.sdk.gameEventManager.notifyGame(
            WavedashEvents.P2P_CONNECTION_ESTABLISHED,
            {
              userId: peer.userId,
              username: peer.username
            } satisfies P2PConnectionEstablishedPayload
          );
        }
      }
    };

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      // Enqueue message directly to its channel queue
      this.enqueueMessage(event.data, remoteUserId);
    };

    channel.onerror = (error: RTCErrorEvent) => {
      logger.error(
        `Data channel error with peer ${remoteUserId}:`,
        error
      );
      const peer = this.currentConnection?.peers[remoteUserId];
      if (peer) {
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.P2P_CONNECTION_FAILED,
          {
            userId: peer.userId,
            username: peer.username,
            error: error.toString()
          } satisfies P2PConnectionFailedPayload
        );
      }
    };

    channel.onclose = () => {
      logger.debug(
        `${type} data channel closed with peer ${remoteUserId}`
      );
      // Clear per-peer flags so a rejoining peer starts clean: a fresh
      // ESTABLISHED and no spurious RECONNECTED from a stale reconnecting
      // flag left over from the failure that caused this close.
      // Idempotent: safe to call for each channel close on the same peer.
      this.establishedPeers.delete(remoteUserId);
      this.reconnectingPeers.delete(remoteUserId);
      const peer = this.currentConnection?.peers[remoteUserId];
      if (peer) {
        this.sdk.gameEventManager.notifyGame(
          WavedashEvents.P2P_PEER_DISCONNECTED,
          {
            userId: peer.userId,
            username: peer.username
          } satisfies P2PPeerDisconnectedPayload
        );
      }
    };
  }

  // ================
  // Message Sending
  // ================

  sendP2PMessage(
    toUserId: Id<"users"> | undefined,
    appChannel: number = 0,
    reliable: boolean = true,
    payload: Uint8Array,
    payloadSize: number = payload.length // use this when using the reusable outgoingMessageBuffer to send only the intended bytes from the buffer
  ): boolean {
    this.ensureInitialized();
    try {
      if (!this.currentConnection) {
        logger.error(
          `P2P send called before P2P is initialized, dropping message.`
        );
        this.reportPacketDrop(appChannel, "SEND", "PEER_NOT_READY");
        return false;
      }

      if (!payload) {
        logger.error(
          `P2P send called with missing payload, dropping message.`
        );
        this.reportPacketDrop(appChannel, "SEND", "INVALID_PAYLOAD_SIZE");
        return false;
      }

      if (
        !Number.isInteger(appChannel) ||
        appChannel < 0 ||
        appChannel >= this.MAX_CHANNELS
      ) {
        logger.error(
          `P2P appChannel must be an integer in [0, ${this.MAX_CHANNELS}), received ${appChannel}, dropping message.`
        );
        // Emit -1 (the JSDoc's sentinel for "not determinable") rather than
        // the raw invalid value, which could be NaN, Infinity, or out of range.
        this.reportPacketDrop(-1, "SEND", "INVALID_CHANNEL");
        return false;
      }

      if (payloadSize <= 0) {
        logger.error(
          `P2P payloadSize must be greater than 0, received ${payloadSize}, dropping message.`
        );
        this.reportPacketDrop(appChannel, "SEND", "INVALID_PAYLOAD_SIZE");
        return false;
      }

      if (payloadSize > this.MAX_PAYLOAD_SIZE) {
        logger.error(
          `P2P payload too large: ${payloadSize} bytes exceeds max ${this.MAX_PAYLOAD_SIZE} bytes, dropping message.`
        );
        this.reportPacketDrop(appChannel, "SEND", "PAYLOAD_TOO_LARGE");
        return false;
      }

      if (payloadSize > payload.length) {
        logger.error(
          `payloadSize is greater than payload buffer length: ${payloadSize} > ${payload.length}, dropping message.`
        );
        this.reportPacketDrop(appChannel, "SEND", "INVALID_PAYLOAD_SIZE");
        return false;
      }

      // Use subarray to get just the bytes we need (no copy, just a view)
      const data =
        payloadSize < payload.length
          ? payload.subarray(0, payloadSize)
          : payload;

      // Called with payload provided - encode it
      const messageData: Uint8Array = this.encodeWireMessage(appChannel, data);

      const channelMap = reliable
        ? this.reliableChannels
        : this.unreliableChannels;

      if (toUserId === undefined) {
        // Broadcast is best-effort: silently skip peers whose channels aren't
        // open
        channelMap.forEach((channel, peerUserId) => {
          if (channel.readyState !== "open") return;
          try {
            channel.send(messageData as Uint8Array<ArrayBuffer>);
          } catch (error) {
            // Just log the error, don't report a packet drop.
            // Game can listen for P2PPeerReconnecting/P2PConnectionFailed for reachability
            logger.error(
              `P2P broadcast to peer ${peerUserId} failed:`,
              error
            );
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toUserId);
        if (!channel || channel.readyState !== "open") {
          logger.error(
            `P2P no open channel to peer ${toUserId}, dropping message.`
          );
          this.reportPacketDrop(appChannel, "SEND", "PEER_NOT_READY");
          return false;
        }
        try {
          channel.send(messageData as Uint8Array<ArrayBuffer>);
        } catch (error) {
          logger.error(
            `P2P send to peer ${toUserId} failed, dropping message:`,
            error
          );
          this.reportPacketDrop(appChannel, "SEND", "PEER_NOT_READY");
          return false;
        }
      }

      return true;
    } catch (error) {
      logger.error(`Error sending P2P message:`, error);
      return false;
    }
  }

  // ================================
  // P2P Signaling Handshake Messages
  // ================================

  private async sendSignalingMessage(
    toUserId: Id<"users">,
    message: {
      type: (typeof P2P_SIGNALING_MESSAGE_TYPE)[keyof typeof P2P_SIGNALING_MESSAGE_TYPE];
      data: RTCSessionDescriptionInit | RTCIceCandidateInit;
    }
  ): Promise<void> {
    if (!this.currentConnection) {
      throw new Error("No active P2P connection for signaling");
    }

    try {
      await this.sdk.convexClient.mutation(
        api.sdk.p2pSignaling.sendSignalingMessage,
        {
          lobbyId: this.currentConnection.lobbyId,
          toUserId: toUserId,
          messageType: message.type,
          data: message.data
        }
      );
      logger.debug("Sent signaling message:", message.type);
    } catch (error) {
      logger.error("Failed to send signaling message:", error);
      throw error;
    }
  }

  // ===============
  // Cleanup
  // ===============

  disconnectP2P(): void {
    if (!this.currentConnection) {
      return;
    }

    this.stopSignalingMessageSubscription();

    (
      Object.entries(this.currentConnection.peers) as [Id<"users">, P2PPeer][]
    ).forEach(([userId, _]) => {
      const pc = this.peerConnections.get(userId);
      if (pc) {
        pc.close();
        this.peerConnections.delete(userId);
      }

      this.reliableChannels.delete(userId);
      this.unreliableChannels.delete(userId);
    });

    this.currentConnection = null;

    this.processedSignalingMessages.clear();
    this.pendingProcessedMessageIds.clear();
    this.pendingIceCandidates.clear();
    this.iceRestartAttempts.clear();
    this.iceRestartInProgress.clear();
    this.reconnectingPeers.clear();
    this.establishedPeers.clear();
    this.clearPacketDropTrackers();

    this.initializationInProgress = null;
    this.initializationLobbyId = null;

    this.signalingSubscriptionReady = null;
    this.signalingSubscriptionReadyResolver = null;
  }

  // ===============
  // Helper Methods
  // ===============

  // Check if channels are ready for a specific peer
  isPeerReady(userId: Id<"users">): boolean {
    if (!this.currentConnection) return false;

    const reliableChannel = this.reliableChannels.get(userId);
    const unreliableChannel = this.unreliableChannels.get(userId);

    const reliableReady =
      !this.config.enableReliableChannel ||
      reliableChannel?.readyState === "open";
    const unreliableReady =
      !this.config.enableUnreliableChannel ||
      unreliableChannel?.readyState === "open";

    return reliableReady && unreliableReady;
  }

  isBroadcastReady(): boolean {
    if (!this.currentConnection) return false;
    return this.reliableChannels.size > 0 && this.unreliableChannels.size > 0;
  }

  // Get status of all peer connections
  getPeerStatuses(): Record<
    Id<"users">,
    { reliable?: string; unreliable?: string; ready: boolean }
  > {
    if (!this.currentConnection) return {};

    const statuses: Record<
      Id<"users">,
      { reliable?: string; unreliable?: string; ready: boolean }
    > = {};

    for (const userId of Object.keys(
      this.currentConnection.peers
    ) as Id<"users">[]) {
      const reliableChannel = this.reliableChannels.get(userId);
      const unreliableChannel = this.unreliableChannels.get(userId);

      statuses[userId] = {
        reliable: reliableChannel?.readyState,
        unreliable: unreliableChannel?.readyState,
        ready: this.isPeerReady(userId)
      };
    }

    return statuses;
  }

  // ================
  // Incoming Message Queues
  // ================

  // Lazily allocate an incoming ring buffer for the given channel.
  // Called from enqueueMessage when the first message arrives on a channel
  // that hasn't been used yet — games that never receive P2P traffic (or
  // only use a subset of channels) never pay for unused queues.
  private createChannelQueue(channel: number): void {
    const queueDataSize = this.MESSAGE_SIZE * this.QUEUE_SIZE;
    const buffer = new ArrayBuffer(queueDataSize);
    const incomingDataView = new Uint8Array(buffer);

    this.channelQueues.set(channel, {
      buffer,
      writeIndex: 0,
      readIndex: 0,
      messageCount: 0,
      incomingDataView
    });

    logger.debug(
      `Allocated P2P ring buffer for channel ${channel} ` +
        `(${(queueDataSize / 1024 / 1024).toFixed(1)}MB)`
    );
  }

  /**
   * Record a packet drop and emit P2P_PACKET_DROPPED with rate-limiting per
   * (channel, direction, reason) tuple. First drop on an idle tuple fires
   * immediately; subsequent drops within PACKET_DROP_WINDOW_MS are coalesced
   * into a single event at the end of the window.
   */
  private reportPacketDrop(
    channel: number,
    direction: "SEND" | "RECEIVE",
    reason: P2PPacketDropReason
  ): void {
    const key = `${direction}:${channel}:${reason}`;
    let tracker = this.packetDropTrackers.get(key);
    if (!tracker) {
      tracker = {
        channel,
        direction,
        reason,
        pendingCount: 0,
        windowTimer: null,
        droppedTotal: 0
      };
      this.packetDropTrackers.set(key, tracker);
    }

    tracker.droppedTotal += 1;

    // Idle → emit immediately and open a window. Keeps first-drop latency at
    // zero for sparse drops.
    if (tracker.windowTimer === null) {
      this.emitPacketDropped(tracker, 1);
      tracker.windowTimer = setTimeout(
        () => this.flushPacketDropWindow(key),
        this.PACKET_DROP_WINDOW_MS
      );
      return;
    }

    // Window active — coalesce silently until it expires.
    tracker.pendingCount += 1;
  }

  private flushPacketDropWindow(key: string): void {
    const tracker = this.packetDropTrackers.get(key);
    if (!tracker) return;

    if (tracker.pendingCount > 0) {
      // Drops continued during the window — emit the aggregate and keep the
      // window open so sustained overload stays rate-limited at ~1/window.
      const count = tracker.pendingCount;
      tracker.pendingCount = 0;
      this.emitPacketDropped(tracker, count);
      tracker.windowTimer = setTimeout(
        () => this.flushPacketDropWindow(key),
        this.PACKET_DROP_WINDOW_MS
      );
    } else {
      // Quiet window — return to idle so the next drop can fire immediately.
      tracker.windowTimer = null;
    }
  }

  private emitPacketDropped(
    tracker: {
      channel: number;
      direction: "SEND" | "RECEIVE";
      reason: P2PPacketDropReason;
      droppedTotal: number;
    },
    droppedCount: number
  ): void {
    this.sdk.gameEventManager.notifyGame(WavedashEvents.P2P_PACKET_DROPPED, {
      channel: tracker.channel,
      direction: tracker.direction,
      reason: tracker.reason,
      droppedCount,
      droppedTotal: tracker.droppedTotal
    } satisfies P2PPacketDroppedPayload);
  }

  private clearPacketDropTrackers(): void {
    for (const tracker of this.packetDropTrackers.values()) {
      if (tracker.windowTimer !== null) {
        clearTimeout(tracker.windowTimer);
      }
    }
    this.packetDropTrackers.clear();
  }

  private enqueueMessage(wireData: ArrayBuffer, fromUserId: Id<"users">): void {
    try {
      if (wireData.byteLength < this.WIRE_PAYLOAD_OFFSET) {
        logger.warn("Binary message too short to extract channel");
        this.reportPacketDrop(-1, "RECEIVE", "MALFORMED");
        return;
      }

      // Channel is 1 byte on the wire and widened to 4 bytes in the slot.
      const wireBytes = new Uint8Array(wireData);
      const channel = wireBytes[this.WIRE_CHANNEL_OFFSET];

      // Create channel queue if it doesn't exist
      if (!this.channelQueues.has(channel)) {
        if (channel >= this.MAX_CHANNELS) {
          logger.warn(
            `Channel ${channel} exceeds max channels (${this.MAX_CHANNELS}), dropping message`
          );
          this.reportPacketDrop(channel, "RECEIVE", "INVALID_CHANNEL");
          return;
        }
        this.createChannelQueue(channel);
      }

      const queue = this.channelQueues.get(channel)!;

      // Check if queue is full
      if (queue.messageCount >= this.QUEUE_SIZE) {
        logger.warn(
          `P2P message queue full for channel ${channel}, dropping message`
        );
        this.reportPacketDrop(channel, "RECEIVE", "QUEUE_FULL");
        return;
      }

      // Slot stores the "enriched" in-memory format so engine decoders can
      // read fromUserId + dataLength inline
      const payloadLength = wireData.byteLength - this.WIRE_PAYLOAD_OFFSET;
      const storedSize = this.PAYLOAD_OFFSET + payloadLength;
      const maxMessageSize = this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE;
      if (storedSize > maxMessageSize) {
        logger.warn(
          `Message too large for queue: ${storedSize} > ${maxMessageSize}, dropping message.`
        );
        this.reportPacketDrop(channel, "RECEIVE", "PAYLOAD_TOO_LARGE");
        return;
      }

      const writeOffset = queue.writeIndex * this.MESSAGE_SIZE;
      const slotContentOffset = writeOffset + this.MESSAGE_SLOT_HEADER_SIZE;

      // Write message size at the beginning of the slot
      const slotView = new DataView(
        queue.buffer,
        writeOffset,
        this.MESSAGE_SIZE
      );
      slotView.setUint32(0, storedSize, true);

      // Slot layout: [fromUserId(32)][channel(4)][dataLength(4)][payload].
      // Prepend the authenticated fromUserId (32 bytes, zero-padded).
      const fromUserIdBytes = this.textEncoder
        .encode(fromUserId)
        .slice(0, this.USERID_SIZE);
      queue.incomingDataView.fill(
        0,
        slotContentOffset,
        slotContentOffset + this.USERID_SIZE
      );
      queue.incomingDataView.set(fromUserIdBytes, slotContentOffset);

      // Re-emit channel (already parsed from wire above) into the slot.
      slotView.setUint32(
        this.MESSAGE_SLOT_HEADER_SIZE + this.CHANNEL_OFFSET,
        channel,
        true
      );

      // Synthesize dataLength from the wire message size (SCTP gave us the
      // boundary; engine decoders still want an explicit length field).
      slotView.setUint32(
        this.MESSAGE_SLOT_HEADER_SIZE + this.DATALENGTH_OFFSET,
        payloadLength,
        true
      );

      // Copy payload from wire into slot.
      if (payloadLength > 0) {
        queue.incomingDataView.set(
          wireBytes.subarray(this.WIRE_PAYLOAD_OFFSET),
          slotContentOffset + this.PAYLOAD_OFFSET
        );
      }

      queue.writeIndex = (queue.writeIndex + 1) % this.QUEUE_SIZE;
      queue.messageCount++;
    } catch (error) {
      logger.error(`Error enqueuing binary P2P message:`, error);
    }
  }

  // Returns the max payload size (what game engines should report as max packet size)
  getMaxPayloadSize(): number {
    this.ensureInitialized();
    return this.MAX_PAYLOAD_SIZE;
  }

  // Returns the configured max incoming messages per channel queue
  getMaxIncomingMessages(): number {
    this.ensureInitialized();
    return this.QUEUE_SIZE;
  }

  // Get pre-allocated buffer for outgoing messages (for game engine to write directly)
  // Game engine can write payload here, then call sendP2PMessage with the same buffer
  // Godot uses this to write binary payloads to a pre-allocated place that JS can read from.
  // Not needed in Unity because Unity can pass along a direct view into its own WASM heap
  getOutgoingMessageBuffer(): Uint8Array {
    this.ensureInitialized();
    return this.outgoingMessageBuffer;
  }

  // Read the next message from a channel as a decoded P2PMessage.
  // Returns null if the queue is empty or hasn't been created yet.
  // Engine builds never call this — they use drainChannelToBuffer to
  // minimize WASM<->JS boundary crossings. JS-only games use this directly.
  readMessageFromChannel(appChannel: number): P2PMessage | null {
    this.ensureInitialized();
    const queue = this.channelQueues.get(appChannel);
    if (!queue) return null;

    const view = this.readRawMessage(queue);
    return view ? this.decodeBinaryMessage(view) : null;
  }

  // Internal helper: pull the next message's raw bytes from a queue as a
  // zero-copy view and advance read pointers. Returns null if the queue is
  // empty or the next slot's header is invalid (invalid slots are dropped —
  // read pointers advance past them even when null is returned).
  private readRawMessage(
    queue: NonNullable<ReturnType<typeof this.channelQueues.get>>
  ): Uint8Array | null {
    if (queue.messageCount === 0) return null;

    const readOffset = queue.readIndex * this.MESSAGE_SIZE;
    const slotView = new DataView(queue.buffer, readOffset, this.MESSAGE_SIZE);
    const messageSize = slotView.getUint32(0, true);
    const maxMessageSize = this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE;

    if (messageSize === 0 || messageSize > maxMessageSize) {
      queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
      queue.messageCount--;
      return null;
    }

    const view = new Uint8Array(
      queue.buffer,
      readOffset + this.MESSAGE_SLOT_HEADER_SIZE,
      messageSize
    );
    queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
    queue.messageCount--;
    return view;
  }

  // Drain all messages from a channel in one call (reduces WASM↔JS boundary crossings)
  // Only intended to be used in game engine context to give raw binary packets to the game engine
  // JS games should just call readMessageFromChannel repeatedly to get decoded P2PMessages
  // Format: [size:4][msg:N][size:4][msg:N]... (tightly packed)
  // Game iterates by reading size, advancing by 4+size, repeat until end of buffer
  // If buffer is provided, fills until full and leaves remaining messages in queue
  // If no buffer provided, allocates exact size needed and drains all messages
  // Returns subarray of buffer containing only the written data (use .length to know how many bytes were written)
  drainChannelToBuffer(appChannel: number, buffer?: Uint8Array): Uint8Array {
    this.ensureInitialized();
    const queue = this.channelQueues.get(appChannel);
    if (!queue || queue.messageCount === 0) {
      return new Uint8Array(0);
    }

    // If no buffer provided (or empty buffer), allocate a new buffer of exact size needed and drain all messages into it
    if (!buffer || buffer.byteLength === 0) {
      const messages: Uint8Array[] = [];
      let totalSize = 0;

      while (queue.messageCount > 0) {
        const msg = this.readRawMessage(queue);
        if (!msg) continue; // invalid slot was skipped
        messages.push(msg);
        totalSize += this.MESSAGE_SLOT_HEADER_SIZE + msg.length;
      }

      if (messages.length === 0) {
        return new Uint8Array(0);
      }

      const result = new Uint8Array(totalSize);
      const resultView = new DataView(result.buffer);
      let writePos = 0;

      for (const msg of messages) {
        resultView.setUint32(writePos, msg.length, true);
        writePos += this.MESSAGE_SLOT_HEADER_SIZE;
        result.set(msg, writePos);
        writePos += msg.length;
      }

      return result;
    }

    // Buffer provided - fill until full, leave remaining messages in queue.
    // One DataView over the queue buffer for all size-prefix reads,
    // one memcpy per message into the output buffer, no intermediate view allocations.
    const resultView = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength
    );
    const queueView = new DataView(queue.buffer);
    const maxMessageSize = this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE;
    let writePos = 0;

    while (queue.messageCount > 0) {
      const readOffset = queue.readIndex * this.MESSAGE_SIZE;
      const messageSize = queueView.getUint32(readOffset, true);

      // Invalid message — drop and keep going
      if (messageSize === 0 || messageSize > maxMessageSize) {
        queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
        queue.messageCount--;
        continue;
      }

      // Fits in remaining output space?
      const spaceNeeded = this.MESSAGE_SLOT_HEADER_SIZE + messageSize;
      if (writePos + spaceNeeded > buffer.byteLength) {
        // Output buffer full; leave this message in the queue for next drain
        break;
      }

      resultView.setUint32(writePos, messageSize, true);
      writePos += this.MESSAGE_SLOT_HEADER_SIZE;
      buffer.set(
        new Uint8Array(
          queue.buffer,
          readOffset + this.MESSAGE_SLOT_HEADER_SIZE,
          messageSize
        ),
        writePos
      );
      writePos += messageSize;

      queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
      queue.messageCount--;
    }

    return buffer.subarray(0, writePos);
  }

  // ================
  // Binary Message Encoding/Decoding
  // ================

  // Wire format: [channel(1)][payload(...)] (no userId, no dataLength)
  private encodeWireMessage(channel: number, payload: Uint8Array): Uint8Array {
    // Defensive guard — sendP2PMessage validates the channel before calling,
    // so this should be unreachable unless a new caller is added.
    if (channel < 0 || channel >= this.MAX_CHANNELS) {
      throw new Error(
        `P2P channel ${channel} must be between 0 and ${this.MAX_CHANNELS - 1}`
      );
    }
    const totalLength = this.WIRE_PAYLOAD_OFFSET + payload.length;
    const uint8View = new Uint8Array(totalLength);

    uint8View[this.WIRE_CHANNEL_OFFSET] = channel;

    if (payload.length > 0) {
      uint8View.set(payload, this.WIRE_PAYLOAD_OFFSET);
    }

    return uint8View;
  }

  private decodeBinaryMessage(data: Uint8Array): P2PMessage {
    // Defensive guard — enqueueMessage writes every slot with a fixed
    // PAYLOAD_OFFSET-byte header, so any slot retrieved from a channel queue
    // is always at least PAYLOAD_OFFSET bytes. Unreachable unless a new
    // caller bypasses the queue.
    if (data.byteLength < this.PAYLOAD_OFFSET) {
      throw new Error("Invalid binary message: too short");
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const uint8View = data;

    let offset = 0;

    // fromUserId (32 bytes)
    const fromUserIdBytes = uint8View.slice(offset, offset + this.USERID_SIZE);
    const fromUserId = this.textDecoder
      .decode(fromUserIdBytes)
      .replace(/\0+$/, "") as Id<"users">;
    offset += this.USERID_SIZE;

    // channel (4 bytes)
    const channel = view.getUint32(offset, true);
    offset += this.CHANNEL_SIZE;

    // data length (4 bytes)
    const dataLength = view.getUint32(offset, true);
    offset += this.DATALENGTH_SIZE;

    // payload (variable length)
    const payload = data.slice(offset, offset + dataLength);

    return {
      fromUserId,
      channel,
      payload: payload
    };
  }
}
