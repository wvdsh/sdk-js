/**
 * P2P networking service
 *
 * Handles WebRTC peer-to-peer connections for lobbies
 */

import type {
  Id,
  WavedashResponse,
  P2PPeer,
  P2PConnection,
  P2PMessage,
  P2PConfig,
  P2PTurnCredentials,
  P2PSignalingMessage
} from "../types";
import { Signals } from "../signals";
import type { WavedashSDK } from "../index";
import { api, P2P_SIGNALING_MESSAGE_TYPE, SDKUser } from "@wvdsh/types";

// Default P2P configuration
const DEFAULT_P2P_CONFIG: P2PConfig = {
  maxPeers: 8,
  enableReliableChannel: true,
  enableUnreliableChannel: true
};

export class P2PManager {
  private sdk: WavedashSDK;
  private currentConnection: P2PConnection | null = null;
  private peerConnections = new Map<Id<"users">, RTCPeerConnection>();
  private reliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private unreliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private pendingIceCandidates = new Map<Id<"users">, RTCIceCandidateInit[]>(); // Buffer ICE candidates until remote description is set
  private config: P2PConfig;
  private processedSignalingMessages = new Set<string>(); // Track processed message IDs
  private connectionStateCheckInterval: ReturnType<typeof setInterval> | null =
    null;

  private turnCredentials: P2PTurnCredentials | null = null; // Cached TURN server credentials for WebRTC relay
  private turnCredentialsInitPromise: Promise<void> | null = null; // Tracks in-flight initialization

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

  private readonly CHECK_CONNECTION_INTERVAL_MS = 1_000; // 1 second

  private readonly QUEUE_SIZE = 1024; // Number of messages per direction per channel
  private readonly MESSAGE_SIZE = 2048; // Max bytes per message slot
  private readonly MESSAGE_SLOT_HEADER_SIZE = 4; // Size prefix at start of each message slot
  private readonly MAX_CHANNELS = 8; // Maximum number of channels to support
  private readonly DEFAULT_NUM_CHANNELS = 3; // Default number of channels to pre-allocate

  // Binary message format offsets
  private readonly USERID_SIZE = 32; // TODO: Switch to int handles so this can be 4 bytes instead of 32
  private readonly CHANNEL_SIZE = 4;
  private readonly DATALENGTH_SIZE = 4;
  private readonly CHANNEL_OFFSET = this.USERID_SIZE; // Channel comes after fromUserId
  private readonly DATALENGTH_OFFSET = this.USERID_SIZE + this.CHANNEL_SIZE;
  private readonly PAYLOAD_OFFSET =
    this.USERID_SIZE + this.CHANNEL_SIZE + this.DATALENGTH_SIZE;
  // Max payload = slot size - slot header - message header (PAYLOAD_OFFSET)
  private readonly MAX_PAYLOAD_SIZE =
    this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE - this.PAYLOAD_OFFSET;

  // Pre-allocated buffer for outgoing messages to avoid repeated allocations
  // Game engine writes payload here, then calls sendP2PMessage
  private outgoingMessageBuffer = new Uint8Array(this.MAX_PAYLOAD_SIZE);
  private textEncoder: TextEncoder = new TextEncoder();
  private textDecoder: TextDecoder = new TextDecoder();

  constructor(sdk: WavedashSDK, config?: Partial<P2PConfig>) {
    this.sdk = sdk;
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
    this.initializeMessageQueue();
  }

  // ================
  // Connection Setup
  // ================

  async initializeP2PForCurrentLobby(
    lobbyId: Id<"lobbies">,
    members: SDKUser[]
  ): Promise<WavedashResponse<P2PConnection>> {
    try {
      // If we already have a connection, update it instead of replacing
      if (
        this.currentConnection &&
        this.currentConnection.lobbyId === lobbyId
      ) {
        return this.updateP2PConnection(members);
      }

      // Create P2P connection state (no more handles needed)
      const connection: P2PConnection = {
        lobbyId,
        peers: {},
        state: "connecting"
      };

      // Populate peers object (excluding local peer)
      members.forEach((member) => {
        if (member.id !== this.sdk.getUserId()) {
          // Use userId as the peer identifier instead of handles
          connection.peers[member.id] = {
            userId: member.id,
            username: member.username
          };
        }
      });

      this.currentConnection = connection;

      // Start WebRTC connection establishment
      await this.establishWebRTCConnections(connection);

      return {
        success: true,
        data: connection,
        args: { lobbyId, members }
      };
    } catch (error) {
      this.sdk.logger.error(
        `Error initializing P2P for lobby ${lobbyId}:`,
        error
      );
      return {
        success: false,
        data: null,
        args: { lobbyId, members },
        message: error instanceof Error ? error.message : String(error)
      };
    }
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
  ): Promise<WavedashResponse<P2PConnection>> {
    try {
      if (!this.currentConnection) {
        throw new Error("No existing P2P connection to update");
      }

      this.sdk.logger.debug("Updating P2P connection with new member list");

      const currentPeerUserIds = new Set(
        Object.keys(this.currentConnection.peers)
      );
      currentPeerUserIds.add(this.sdk.getUserId());
      const newPeerUserIds = new Set(members.map((member) => member.id));

      // Find new users who joined
      const connectionsToCreate: Id<"users">[] = [];
      for (const member of members) {
        if (
          !currentPeerUserIds.has(member.id) &&
          member.id !== this.sdk.getUserId()
        ) {
          this.sdk.logger.debug(
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
          this.sdk.logger.debug(
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
          // Small delay to ensure data channels are set up before creating offers
          await new Promise((resolve) => setTimeout(resolve, 100));

          const offerPromises = peersToInitiate.map((userId) => {
            this.sdk.logger.debug(
              `Initiating offer to new peer ${userId} (lower userId rule)`
            );
            return this.createOfferToPeer(userId);
          });

          await Promise.all(offerPromises);
          this.sdk.logger.debug(
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
          this.sdk.logger.debug(`Peer left: ${peer.username} (${userId})`);

          // Clean up WebRTC resources
          const pc = this.peerConnections.get(userId);
          if (pc) {
            pc.close();
            this.peerConnections.delete(userId);
          }
          this.reliableChannels.delete(userId);
          this.unreliableChannels.delete(userId);
          this.pendingIceCandidates.delete(userId);

          // Remove from peer list
          delete this.currentConnection.peers[userId];
        }
      }

      return {
        success: true,
        data: this.currentConnection,
        args: { members }
      };
    } catch (error) {
      this.sdk.logger.error("Error updating P2P connection:", error);
      return {
        success: false,
        data: null,
        args: { members },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async establishWebRTCConnections(
    connection: P2PConnection
  ): Promise<void> {
    // Subscribe to real-time signaling message updates
    this.subscribeToSignalingMessages(connection);

    // Establish WebRTC connections immediately (no need to wait for assignments)
    await this.establishPeerConnections(connection);

    connection.state = "connecting";

    // Start polling connection state
    this.startConnectionStatePolling();
  }

  // Periodically check peer connection states and update connection.state
  private startConnectionStatePolling(): void {
    // Clear any existing interval
    this.stopConnectionStatePolling();

    this.connectionStateCheckInterval = setInterval(() => {
      this.updateConnectionState();
    }, this.CHECK_CONNECTION_INTERVAL_MS);

    // Also do an immediate check
    this.updateConnectionState();
  }

  private stopConnectionStatePolling(): void {
    if (this.connectionStateCheckInterval !== null) {
      clearInterval(this.connectionStateCheckInterval);
      this.connectionStateCheckInterval = null;
    }
  }

  private updateConnectionState(): void {
    if (!this.currentConnection) return;

    const peerIds = Object.keys(this.currentConnection.peers) as Id<"users">[];
    const previousState = this.currentConnection.state;

    // No peers means disconnected
    if (peerIds.length === 0) {
      this.currentConnection.state = "disconnected";
    }
    // All peers are connected
    else if (this.allPeersConnected()) {
      this.currentConnection.state = "connected";
    }
    // Have peers but not all connected
    else {
      this.currentConnection.state = "connecting";
    }

    // Log state changes
    if (previousState !== this.currentConnection.state) {
      const connectedCount = peerIds.filter((userId) =>
        this.isPeerReady(userId)
      ).length;
      this.sdk.logger.debug(
        `P2P connection state: ${previousState} → ${this.currentConnection.state} ` +
          `(${connectedCount}/${peerIds.length} peers connected)`
      );
    }
  }

  private unsubscribeFromSignalingMessages: (() => void) | null = null;
  private pendingProcessedMessageIds = new Set<Id<"p2pSignalingMessages">>();

  private subscribeToSignalingMessages(connection: P2PConnection): void {
    // Subscribe to real-time signaling message updates
    this.unsubscribeFromSignalingMessages = this.sdk.convexClient.onUpdate(
      api.sdk.p2pSignaling.getSignalingMessages,
      { lobbyId: connection.lobbyId },
      (messages) => {
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
        this.sdk.logger.error("Error handling signaling message:", error);
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
        this.sdk.logger.error(
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
    if (!connection.peers[remoteUserId]) {
      this.sdk.logger.warn(
        "Received signaling message from unknown user:",
        remoteUserId
      );
      return;
    }

    const pc = this.peerConnections.get(remoteUserId);
    if (!pc) {
      this.sdk.logger.warn("No peer connection for user:", remoteUserId);
      return;
    }

    switch (message.messageType) {
      case P2P_SIGNALING_MESSAGE_TYPE.OFFER: {
        // Log offer processing details
        this.sdk.logger.debug(`Processing offer from peer ${remoteUserId}:`);

        await pc.setRemoteDescription(
          new RTCSessionDescription(message.data as RTCSessionDescriptionInit)
        );

        // Flush any buffered ICE candidates now that remote description is set
        await this.flushPendingIceCandidates(remoteUserId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.sdk.logger.debug(
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
          this.sdk.logger.debug(
            `Buffered ICE candidate for ${remoteUserId} (remote description not yet set, ${pending.length} buffered)`
          );
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(iceData));
        }
        break;
      }

      default:
        this.sdk.logger.warn(
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
          this.sdk.logger.warn(
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
    this.sdk.logger.debug("Establishing WebRTC connections to peers...");

    const currentUserId = this.sdk.getUserId();
    const connectionPromises: Promise<boolean>[] = [];

    // Create peer connections to all other peers
    (Object.entries(connection.peers) as [Id<"users">, P2PPeer][]).forEach(
      ([userId, peer]) => {
        const shouldCreateChannels = currentUserId < userId;
        this.sdk.logger.debug(
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
      // Small delay to ensure data channels are properly set up before creating offers
      await new Promise((resolve) => setTimeout(resolve, 100));

      const offerPromises = peersToInitiate.map((userId) => {
        this.sdk.logger.debug(
          `Initiating offer to peer ${userId} (lower userId rule)`
        );
        return this.createOfferToPeer(userId);
      });

      await Promise.all(offerPromises);
      this.sdk.logger.debug(
        `Created ${connectionPromises.length} peer connections and initiated ${offerPromises.length} offers`
      );
    } else {
      this.sdk.logger.debug(
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
    this.sdk.logger.debug(`Creating offer to peer ${remoteUserId}:`);
    this.sdk.logger.debug(
      `  Reliable channel state: ${reliableChannel?.readyState || "none"}`
    );
    this.sdk.logger.debug(
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
      this.sdk.logger.error(
        `No ICE servers available for peer ${remoteUserId}`
      );
      this.sdk.notifyGame(Signals.P2P_CONNECTION_FAILED, {
        userId: remoteUserId,
        username: connection.peers[remoteUserId]?.username || "",
        error: "No ICE servers available"
      });
      return false;
    }
    const pc = new RTCPeerConnection({
      iceServers: iceServers,
      // Start gathering ICE candidates in the background as soon as the RTCPeerConnection is created
      iceCandidatePoolSize: 5,
      // Allow all IP addresses (helpful for same-device testing)
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require"
    });

    // Only create data channels if this peer will initiate the offer
    if (shouldCreateChannels) {
      this.sdk.logger.debug(`Creating data channels for peer ${remoteUserId}`);

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
      this.sdk.logger.debug(
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

        this.sdk.logger.debug(
          `Peer ${remoteUserId} gathered ICE candidate: ${candidateType}`
        );
        this.sdk.logger.debug(`  Candidate: ${event.candidate.candidate}`);

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
      this.sdk.logger.debug(
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
      this.sdk.logger.debug(
        `Peer ${remoteUserId} connection state: ${pc.connectionState}`
      );
      if (pc.connectionState === "connected") {
        this.sdk.logger.debug(
          `  Peer ${remoteUserId} fully connected, expecting ondatachannel events now...`
        );
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.sdk.logger.debug(
        `Peer ${remoteUserId} ICE connection state: ${pc.iceConnectionState}`
      );
      if (pc.iceConnectionState === "connected") {
        this.sdk.logger.debug(
          `  ICE connected to peer ${remoteUserId}, data channels should be available...`
        );
      }
    };

    pc.onicegatheringstatechange = () => {
      this.sdk.logger.debug(
        `Peer ${remoteUserId} ICE gathering state: ${pc.iceGatheringState}`
      );
    };

    this.peerConnections.set(remoteUserId, pc);
    return true;
  }

  private setupDataChannelHandlers(
    channel: RTCDataChannel,
    remoteUserId: Id<"users">,
    type: "reliable" | "unreliable"
  ): void {
    channel.onopen = () => {
      this.sdk.logger.debug(
        `${type} data channel opened with peer ${remoteUserId}`
      );

      // Check if this peer is now fully ready (both channels open if both are enabled)
      if (this.isPeerReady(remoteUserId)) {
        const peer = this.currentConnection?.peers[remoteUserId];
        if (peer) {
          this.sdk.notifyGame(Signals.P2P_CONNECTION_ESTABLISHED, {
            userId: peer.userId,
            username: peer.username
          });
        }
      }
    };

    channel.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      // Enqueue the raw binary data directly to SharedArrayBuffer queue
      this.enqueueMessage(event.data);
    };

    channel.onerror = (error: RTCErrorEvent) => {
      this.sdk.logger.error(
        `Data channel error with peer ${remoteUserId}:`,
        error
      );
      const peer = this.currentConnection?.peers[remoteUserId];
      if (peer) {
        this.sdk.notifyGame(Signals.P2P_CONNECTION_FAILED, {
          userId: peer.userId,
          username: peer.username,
          error: error.toString()
        });
      }
    };

    channel.onclose = () => {
      this.sdk.logger.debug(
        `${type} data channel closed with peer ${remoteUserId}`
      );
      const peer = this.currentConnection?.peers[remoteUserId];
      if (peer) {
        this.sdk.notifyGame(Signals.P2P_PEER_DISCONNECTED, {
          userId: peer.userId,
          username: peer.username
        });
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
    payloadSize: number = payload.length
  ): boolean {
    try {
      if (!this.currentConnection || !payload) {
        return false;
      }

      if (payloadSize > this.MAX_PAYLOAD_SIZE) {
        this.sdk.logger.error(
          `P2P payload too large: ${payloadSize} bytes exceeds max ${this.MAX_PAYLOAD_SIZE} bytes`
        );
        return false;
      }

      // Use subarray to get just the bytes we need (no copy, just a view)
      const data =
        payloadSize < payload.length
          ? payload.subarray(0, payloadSize)
          : payload;

      // Called with payload provided - encode it
      const message: P2PMessage = {
        fromUserId: this.sdk.getUserId(),
        channel: appChannel,
        payload: data
      };
      const messageData: Uint8Array = this.encodeBinaryMessage(message);

      const channelMap = reliable
        ? this.reliableChannels
        : this.unreliableChannels;

      if (toUserId === undefined) {
        // Broadcast to all peers
        channelMap.forEach((channel) => {
          if (channel.readyState === "open") {
            channel.send(messageData as Uint8Array<ArrayBuffer>);
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toUserId);
        if (!channel || channel.readyState !== "open") {
          throw new Error(`No open channel to peer ${toUserId}`);
        }
        channel.send(messageData as Uint8Array<ArrayBuffer>);
      }

      return true;
    } catch (error) {
      this.sdk.logger.error(`Error sending P2P message:`, error);
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
      this.sdk.logger.debug("Sent signaling message:", message.type);
    } catch (error) {
      this.sdk.logger.error("Failed to send signaling message:", error);
      throw error;
    }
  }

  // ===============
  // Cleanup
  // ===============

  disconnectP2P(): WavedashResponse<boolean> {
    try {
      if (!this.currentConnection) {
        return {
          success: true,
          data: true,
          args: {}
        };
      }

      // Stop connection state polling
      this.stopConnectionStatePolling();

      // Update state to disconnected
      this.currentConnection.state = "disconnected";
      this.sdk.logger.debug("P2P connection state: disconnected");

      // Stop signaling message polling
      this.stopSignalingMessageSubscription();

      // Close all peer connections
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

      // Clear processed message caches
      this.processedSignalingMessages.clear();
      this.pendingProcessedMessageIds.clear();
      this.pendingIceCandidates.clear();

      return {
        success: true,
        data: true,
        args: {}
      };
    } catch (error) {
      this.sdk.logger.error(`Error disconnecting P2P:`, error);
      return {
        success: false,
        data: false,
        args: {},
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // ===============
  // Helper Methods
  // ===============

  getCurrentP2PConnection(): P2PConnection | null {
    return this.currentConnection;
  }

  updateConfig(config: Partial<P2PConfig>): void {
    this.config = { ...this.config, ...config };
  }

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

  // Check if all peers are connected
  private allPeersConnected(): boolean {
    if (!this.currentConnection) return false;

    const peerIds = Object.keys(this.currentConnection.peers) as Id<"users">[];
    if (peerIds.length === 0) return true; // No peers means "connected"

    return peerIds.every((userId) => this.isPeerReady(userId));
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
  // SharedArrayBuffer Message Queue
  // ================

  private initializeMessageQueue(): void {
    try {
      // Pre-create queues for common channels (0-3)
      for (let channel = 0; channel < this.DEFAULT_NUM_CHANNELS; channel++) {
        this.createChannelQueue(channel);
      }

      this.sdk.logger.debug(
        `Initialized ${this.DEFAULT_NUM_CHANNELS} P2P message queues`
      );
    } catch (error) {
      this.sdk.logger.warn("Failed to initialize P2P message queues:", error);
    }
  }

  private createChannelQueue(channel: number): void {
    // Only incoming queue needed (P2P network → Game engine)
    const queueDataSize = this.MESSAGE_SIZE * this.QUEUE_SIZE;
    const buffer = new ArrayBuffer(queueDataSize);
    const incomingDataView = new Uint8Array(buffer);

    this.channelQueues.set(channel, {
      buffer,
      writeIndex: 0,
      readIndex: 0,
      messageCount: 0,
      incomingDataView,
    });
  }

  private enqueueMessage(binaryData: ArrayBuffer): void {
    try {
      // Extract channel from the binary data to determine which queue to use
      if (binaryData.byteLength < this.CHANNEL_OFFSET + this.CHANNEL_SIZE) {
        this.sdk.logger.warn("Binary message too short to extract channel");
        return;
      }

      const view = new DataView(binaryData);
      const channel = view.getUint32(this.CHANNEL_OFFSET, true);

      // Create channel queue if it doesn't exist
      if (!this.channelQueues.has(channel)) {
        if (channel >= this.MAX_CHANNELS) {
          this.sdk.logger.warn(
            `Channel ${channel} exceeds max channels (${this.MAX_CHANNELS}), dropping message`
          );
          return;
        }
        this.createChannelQueue(channel);
      }

      const queue = this.channelQueues.get(channel)!;

      // Check if queue is full
      if (queue.messageCount >= this.QUEUE_SIZE) {
        this.sdk.logger.warn(
          `P2P message queue full for channel ${channel}, dropping message`
        );
        return;
      }

      // Check if message fits in slot (after size prefix)
      const maxMessageSize = this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE;
      if (binaryData.byteLength > maxMessageSize) {
        this.sdk.logger.warn(
          `Message too large for queue: ${binaryData.byteLength} > ${maxMessageSize}`
        );
        return;
      }

      // Calculate write position in the data buffer
      const writeOffset = queue.writeIndex * this.MESSAGE_SIZE;

      // Write message size at the beginning of the slot
      const slotView = new DataView(
        queue.buffer,
        writeOffset,
        this.MESSAGE_SIZE
      );
      slotView.setUint32(0, binaryData.byteLength, true);

      // Write raw binary message data (after size prefix)
      const messageBytes = new Uint8Array(binaryData);
      queue.incomingDataView.set(
        messageBytes,
        writeOffset + this.MESSAGE_SLOT_HEADER_SIZE
      );

      // Update queue pointers
      queue.writeIndex = (queue.writeIndex + 1) % this.QUEUE_SIZE;
      queue.messageCount++;
    } catch (error) {
      this.sdk.logger.error(`Error enqueuing binary P2P message:`, error);
    }
  }

  // Public method to get queue info for debugging
  getMessageQueueInfo(): {
    channels: number;
    queueSize: number;
    messageSize: number;
    totalSize: number;
  } {
    const totalSize =
      this.channelQueues.size * (this.MESSAGE_SIZE * this.QUEUE_SIZE);

    return {
      channels: this.channelQueues.size,
      queueSize: this.QUEUE_SIZE,
      messageSize: this.MESSAGE_SIZE,
      totalSize: totalSize
    };
  }

  // Get pre-allocated buffer for outgoing messages (for game engine to write directly)
  // Game engine can write payload here, then call sendP2PMessage with the same buffer
  // Godot uses this to write binary payloads to a pre-allocated place that JS can read from.
  // Not needed in Unity because Unity can pass along a direct view into its own WASM heap
  getOutgoingMessageBuffer(): Uint8Array {
    return this.outgoingMessageBuffer;
  }

  // Read one message from the incoming queue for a specific channel
  // Returns raw binary to game engines
  // Returns decoded P2PMessage if called in a JS context
  readMessageFromChannel(appChannel: number): Uint8Array | P2PMessage | null {
    const queue = this.channelQueues.get(appChannel);
    if (!queue) {
      return this.sdk.engineInstance ? new Uint8Array(0) : null;
    }

    if (queue.messageCount === 0) {
      return this.sdk.engineInstance ? new Uint8Array(0) : null;
    }

    const readOffset = queue.readIndex * this.MESSAGE_SIZE;

    const slotView = new DataView(queue.buffer, readOffset, this.MESSAGE_SIZE);
    const messageSize = slotView.getUint32(0, true);

    const maxMessageSize = this.MESSAGE_SIZE - this.MESSAGE_SLOT_HEADER_SIZE;
    if (messageSize === 0 || messageSize > maxMessageSize) {
      // Invalid message, skip it
      queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
      queue.messageCount--;
      return this.sdk.engineInstance ? new Uint8Array(0) : null;
    }

    // Create a view directly from the buffer (no copying needed for incoming messages)
    const messageView = new Uint8Array(
      queue.buffer,
      readOffset + this.MESSAGE_SLOT_HEADER_SIZE,
      messageSize
    );

    queue.readIndex = (queue.readIndex + 1) % this.QUEUE_SIZE;
    queue.messageCount--;

    // Engine gets the raw binary, JS gets the decoded P2PMessage
    return this.sdk.engineInstance
      ? messageView
      : this.decodeBinaryMessage(messageView);
  }

  // Drain all messages from a channel in one call (reduces WASM↔JS boundary crossings)
  // Format: [size:4][msg:N][size:4][msg:N]... (tightly packed)
  // Game iterates by reading size, advancing by 4+size, repeat until end of buffer
  drainChannel(appChannel: number): Uint8Array {
    const messages: Uint8Array[] = [];
    const queue = this.channelQueues.get(appChannel);
    if (!queue) {
      return new Uint8Array(0);
    }
    let totalSize = 0;

    while (queue.messageCount > 0) {
      const msg = this.readMessageFromChannel(appChannel);
      if (!msg || (msg instanceof Uint8Array && msg.length === 0)) {
        break;
      }
      const msgBytes = msg as Uint8Array;
      messages.push(msgBytes);
      totalSize += this.MESSAGE_SLOT_HEADER_SIZE + msgBytes.length;
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

  // ================
  // Binary Message Encoding/Decoding
  // ================

  private encodeBinaryMessage(message: P2PMessage): Uint8Array {
    // Binary format: [fromUserId(32)][channel(4)][dataLength(4)][payload(...)]
    const fromUserIdBytes = this.textEncoder
      .encode(message.fromUserId)
      .slice(0, this.USERID_SIZE);
    const payloadBytes = message.payload;

    const totalLength = this.PAYLOAD_OFFSET + payloadBytes.length;
    const uint8View = new Uint8Array(totalLength);
    const view = new DataView(uint8View.buffer);

    let offset = 0;

    // fromUserId (32 bytes, padded with zeros)
    uint8View.set(fromUserIdBytes, offset);
    offset += this.USERID_SIZE;

    // channel (4 bytes)
    view.setUint32(offset, message.channel, true);
    offset += this.CHANNEL_SIZE;

    // data length (4 bytes)
    view.setUint32(offset, payloadBytes.length, true);
    offset += this.DATALENGTH_SIZE;

    // payload (variable length)
    if (payloadBytes.length > 0) {
      uint8View.set(payloadBytes, offset);
    }

    return uint8View;
  }

  private decodeBinaryMessage(data: Uint8Array): P2PMessage {
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
