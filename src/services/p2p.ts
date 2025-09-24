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
  WavedashUser,
} from '../types';
import { Signals } from '../signals';
import { api } from '../_generated/convex_api';
import type { WavedashSDK } from '../index';
import { P2P_SIGNALING_MESSAGE_TYPE } from '../_generated/constants';

// Default P2P configuration  
const DEFAULT_P2P_CONFIG: P2PConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // v1 basic coturn server running on a t2.micro for development
    // TODO: production should scale this to more global edge TURN servers or use a TURN server provider
    {
      urls: "turn:turn.wavedash.gg:3478",
      username: "webrtc",
      credential: "wavedashturnsecret123"
    }
  ],
  maxPeers: 8,
  enableReliableChannel: true,
  enableUnreliableChannel: true,
};

export class P2PManager {
  private sdk: WavedashSDK;
  private currentConnection: P2PConnection | null = null;
  private peerConnections = new Map<Id<"users">, RTCPeerConnection>();
  private reliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private unreliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private config: P2PConfig;
  private processedSignalingMessages = new Set<string>(); // Track processed message IDs
  
  // SharedArrayBuffer message queues - one per channel for performance
  private channelQueues = new Map<number, {
    buffer: SharedArrayBuffer;
    incomingHeaderView: Int32Array;     // P2P network → Game engine (JS writes, engine reads)
    incomingDataView: Uint8Array;
    outgoingHeaderView: Int32Array;     // Game engine → P2P network (engine writes, JS reads)
    outgoingDataView: Uint8Array;
  }>();
  private readonly QUEUE_SIZE = 256; // Number of messages per direction per channel
  private readonly MESSAGE_SIZE = 1024; // Max bytes per message
  private readonly HEADER_SIZE = 16; // Queue metadata: writeIndex, readIndex, messageCount, version
  private readonly MAX_CHANNELS = 4; // Maximum number of channels to support
  
  // Binary message format offsets
  private readonly USERID_SIZE = 32;  // TODO: Switch to int handles so this can be 4 bytes instead of 32
  private readonly CHANNEL_SIZE = 4;
  private readonly DATALENGTH_SIZE = 4;
  private readonly CHANNEL_OFFSET = this.USERID_SIZE; // Channel comes after fromUserId
  private readonly DATALENGTH_OFFSET = this.USERID_SIZE + this.CHANNEL_SIZE;
  private readonly PAYLOAD_OFFSET = this.USERID_SIZE + this.CHANNEL_SIZE + this.DATALENGTH_SIZE;

  constructor(sdk: WavedashSDK, config?: Partial<P2PConfig>) {
    this.sdk = sdk;
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
    this.initializeMessageQueue();
  }

  // ================
  // Connection Setup
  // ================

  async initializeP2PForCurrentLobby(lobbyId: Id<"lobbies">, members: WavedashUser[]): Promise<WavedashResponse<P2PConnection>> {
    try {
      // If we already have a connection, update it instead of replacing
      if (this.currentConnection && this.currentConnection.lobbyId === lobbyId) {
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
      this.sdk.logger.error(`Error initializing P2P for lobby ${lobbyId}:`, error);
      return {
        success: false,
        data: null,
        args: { lobbyId, members },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async updateP2PConnection(members: WavedashUser[]): Promise<WavedashResponse<P2PConnection>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No existing P2P connection to update');
      }

      this.sdk.logger.debug('Updating P2P connection with new member list');

      const currentPeerUserIds = new Set(Object.keys(this.currentConnection.peers));
      currentPeerUserIds.add(this.sdk.getUserId());
      const newPeerUserIds = new Set(members.map(member => member.id));

      // Find new users who joined
      const connectionsToCreate: Id<"users">[] = [];
      for (const member of members) {
        if (!currentPeerUserIds.has(member.id) && member.id !== this.sdk.getUserId()) {
          this.sdk.logger.debug(`Adding new peer: ${member.username} (${member.id})`);
          
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
        const connectionPromises = connectionsToCreate.map(userId => {
          const shouldCreateChannels = currentUserId < userId;
          this.sdk.logger.debug(`Creating connection to new peer ${userId}, shouldCreateChannels: ${shouldCreateChannels}`);
          return this.createPeerConnection(userId, this.currentConnection!, shouldCreateChannels);
        });
        await Promise.all(connectionPromises);

        // Initiate offers to new peers where we have lower userId
        const peersToInitiate = connectionsToCreate.filter(userId => currentUserId < userId);
        
        if (peersToInitiate.length > 0) {
          // Small delay to ensure data channels are set up before creating offers
          await new Promise(resolve => setTimeout(resolve, 100));
          
          const offerPromises = peersToInitiate.map(userId => {
            this.sdk.logger.debug(`Initiating offer to new peer ${userId} (lower userId rule)`);
            return this.createOfferToPeer(userId);
          });
          
          await Promise.all(offerPromises);
          this.sdk.logger.debug(`Initiated ${offerPromises.length} offers to new peers`);
        }
      }

      // Clean up connections to users who left
      for (const userId of Object.keys(this.currentConnection.peers) as Id<"users">[]) {
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
      this.sdk.logger.error('Error updating P2P connection:', error);
      return {
        success: false,
        data: null,
        args: { members },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async establishWebRTCConnections(connection: P2PConnection): Promise<void> {
    // Subscribe to real-time signaling message updates
    this.subscribeToSignalingMessages(connection);

    // Establish WebRTC connections immediately (no need to wait for assignments)
    await this.establishPeerConnections(connection);

    connection.state = "connecting";
  }


  private unsubscribeFromSignalingMessages: (() => void) | null = null;
  private pendingProcessedMessageIds = new Set<Id<"p2pSignalingMessages">>();

  private subscribeToSignalingMessages(connection: P2PConnection): void {
    // Subscribe to real-time signaling message updates
    this.unsubscribeFromSignalingMessages = this.sdk.convexClient.onUpdate(
      api.p2pSignaling.getSignalingMessages,
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

  private async processSignalingMessages(messages: any[], connection: P2PConnection): Promise<void> {
    if (messages.length === 0) return;

    const newMessageIds: Id<"p2pSignalingMessages">[] = [];
    const messagesToProcess: any[] = [];

    // Filter out messages we've already processed or are pending processing
    for (const message of messages) {
      if (!this.processedSignalingMessages.has(message._id) && 
          !this.pendingProcessedMessageIds.has(message._id)) {
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
        this.sdk.logger.error('Error handling signaling message:', error);
      }
    }

    // Mark all messages as processed in batch
    if (newMessageIds.length > 0) {
      try {
        await this.sdk.convexClient.mutation(
          api.p2pSignaling.markSignalingMessagesProcessed,
          { messageIds: newMessageIds }
        );
        
        // Remove from pending set after successful batch processing
        for (const messageId of newMessageIds) {
          this.pendingProcessedMessageIds.delete(messageId);
        }
      } catch (error) {
        this.sdk.logger.error('Failed to mark signaling messages as processed:', error);
        // Remove from pending set even on failure to avoid permanent blocking
        for (const messageId of newMessageIds) {
          this.pendingProcessedMessageIds.delete(messageId);
        }
      }
    }
  }

  private async handleSignalingMessage(message: any, connection: P2PConnection): Promise<void> {
    // Skip messages from ourselves
    if (message.fromUserId === this.sdk.getUserId()) {
      return;
    }

    const remoteUserId = message.fromUserId;
    if (!connection.peers[remoteUserId]) {
      this.sdk.logger.warn('Received signaling message from unknown user:', remoteUserId);
      return;
    }

    const pc = this.peerConnections.get(remoteUserId);
    if (!pc) {
      this.sdk.logger.warn('No peer connection for user:', remoteUserId);
      return;
    }

    switch (message.messageType) {
      case P2P_SIGNALING_MESSAGE_TYPE.OFFER:
        // Log offer processing details
        this.sdk.logger.debug(`Processing offer from peer ${remoteUserId}:`);
        
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        this.sdk.logger.debug(`  Answer created, waiting for ondatachannel events...`);
        
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

      case P2P_SIGNALING_MESSAGE_TYPE.ANSWER:
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE:
        await pc.addIceCandidate(new RTCIceCandidate(message.data));
        break;

      default:
        this.sdk.logger.warn('Unknown signaling message type:', message.messageType);
    }
  }


  private async establishPeerConnections(connection: P2PConnection): Promise<void> {
    this.sdk.logger.debug('Establishing WebRTC connections to peers...');

    const currentUserId = this.sdk.getUserId();
    const connectionPromises: Promise<void>[] = [];
    
    // Create peer connections to all other peers
    (Object.entries(connection.peers) as [Id<"users">, P2PPeer][]).forEach(([userId, peer]) => {
      const shouldCreateChannels = currentUserId < userId;
      this.sdk.logger.debug(`Creating connection to peer ${userId} (${peer.username}), shouldCreateChannels: ${shouldCreateChannels}`);
      connectionPromises.push(this.createPeerConnection(userId, connection, shouldCreateChannels));
    });

    // Wait for all connections to be created first
    await Promise.all(connectionPromises);
    
    // Initiate offers to peers where we have lower userId
    const peersToInitiate = (Object.keys(connection.peers) as Id<"users">[]).filter(userId => currentUserId < userId);
    
    if (peersToInitiate.length > 0) {
      // Small delay to ensure data channels are properly set up before creating offers
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const offerPromises = peersToInitiate.map(userId => {
        this.sdk.logger.debug(`Initiating offer to peer ${userId} (lower userId rule)`);
        return this.createOfferToPeer(userId);
      });
      
      await Promise.all(offerPromises);
      this.sdk.logger.debug(`Created ${connectionPromises.length} peer connections and initiated ${offerPromises.length} offers`);
    } else {
      this.sdk.logger.debug(`Created ${connectionPromises.length} peer connections, no offers to initiate`);
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
    this.sdk.logger.debug(`  Reliable channel state: ${reliableChannel?.readyState || 'none'}`);
    this.sdk.logger.debug(`  Unreliable channel state: ${unreliableChannel?.readyState || 'none'}`);

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

  private async createPeerConnection(remoteUserId: Id<"users">, connection: P2PConnection, shouldCreateChannels: boolean = false): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers,
      // Enable more aggressive ICE gathering for local testing
      iceCandidatePoolSize: 10,
      // Allow all IP addresses (helpful for same-device testing)
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    });

    // Only create data channels if this peer will initiate the offer
    if (shouldCreateChannels) {
      this.sdk.logger.debug(`Creating data channels for peer ${remoteUserId}`);
      
      if (this.config.enableReliableChannel) {
        const reliableChannel = pc.createDataChannel('reliable', {
          ordered: true,
          maxRetransmits: undefined // Full reliability, will retransmit until received
        });
        this.reliableChannels.set(remoteUserId, reliableChannel);
        this.setupDataChannelHandlers(reliableChannel, remoteUserId, 'reliable');
      }

      if (this.config.enableUnreliableChannel) {
        const unreliableChannel = pc.createDataChannel('unreliable', {
          ordered: false,
          maxRetransmits: 0, // No retransmits, will drop if not received
        });
        this.unreliableChannels.set(remoteUserId, unreliableChannel);
        this.setupDataChannelHandlers(unreliableChannel, remoteUserId, 'unreliable');
      }
    } else {
      this.sdk.logger.debug(`Will receive data channels from peer ${remoteUserId} via ondatachannel`);
    }

    // Set up peer connection event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Log candidate type for debugging
        const candidateType = event.candidate.candidate.includes('typ host') ? 'host' :
                             event.candidate.candidate.includes('typ srflx') ? 'srflx (STUN)' :
                             event.candidate.candidate.includes('typ relay') ? 'relay (TURN)' : 'unknown';
        
        this.sdk.logger.debug(`Peer ${remoteUserId} gathered ICE candidate: ${candidateType}`);
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
      this.sdk.logger.debug(`Received ${channel.label} data channel from peer ${remoteUserId}`);
      
      // Store the received channel in the appropriate map
      if (channel.label === 'reliable') {
        this.reliableChannels.set(remoteUserId, channel);
      } else if (channel.label === 'unreliable') {
        this.unreliableChannels.set(remoteUserId, channel);
      }
      
      this.setupDataChannelHandlers(channel, remoteUserId, channel.label as 'reliable' | 'unreliable');
    };

    // Add connection state monitoring for debugging
    pc.onconnectionstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteUserId} connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        this.sdk.logger.debug(`  Peer ${remoteUserId} fully connected, expecting ondatachannel events now...`);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteUserId} ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        this.sdk.logger.debug(`  ICE connected to peer ${remoteUserId}, data channels should be available...`);
      }
    };

    pc.onicegatheringstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteUserId} ICE gathering state: ${pc.iceGatheringState}`);
    };

    this.peerConnections.set(remoteUserId, pc);
  }

  private setupDataChannelHandlers(channel: RTCDataChannel, remoteUserId: Id<"users">, type: 'reliable' | 'unreliable'): void {
    channel.onopen = () => {
      this.sdk.logger.debug(`${type} data channel opened with peer ${remoteUserId}`);
      
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

    channel.onmessage = (event) => {
      // Enqueue the raw binary data directly to SharedArrayBuffer queue
      this.enqueueBinaryMessage(event.data);
    };

    channel.onerror = (error) => {
      this.sdk.logger.error(`Data channel error with peer ${remoteUserId}:`, error);
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
      this.sdk.logger.debug(`${type} data channel closed with peer ${remoteUserId}`);
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

  // TODO Calvin: Try having JS poll the queue and send all queued messages once per tick rather than sending small packets one at a time
  sendP2PMessage(toUserId: Id<"users"> | undefined, appChannel: number = 0, reliable: boolean = true, payload?: ArrayBuffer | string | Uint8Array): boolean {
    try {
      if (!this.currentConnection) {
        return false;
      }

      let messageData: Uint8Array;

      // Check if we're being called with channel number (read from queue) or direct data
      if (!payload) {
        // No payload provided, read from outgoing queue at specified channel
        const channel = appChannel;
        const queueData = this.readFromOutgoingQueue(channel);
        if (!queueData) {
          return false;
        }
        messageData = queueData;
      } else {
        // Called with payload provided - encode it
        const message: P2PMessage = {
          fromUserId: this.sdk.getUserId(),
          channel: appChannel,
          payload: payload
        };
        messageData = this.encodeBinaryMessage(message);
      }

      const channelMap = reliable ? this.reliableChannels : this.unreliableChannels;

      if (toUserId === undefined) {
        // Broadcast to all peers
        channelMap.forEach((channel) => {
          if (channel.readyState === 'open') {
            channel.send(messageData as Uint8Array<ArrayBuffer>);
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toUserId);
        if (!channel || channel.readyState !== 'open') {
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

  private async sendSignalingMessage(toUserId: Id<"users">, message: { type: any; data: any }): Promise<void> {
    if (!this.currentConnection) {
      throw new Error('No active P2P connection for signaling');
    }

    try {
      await this.sdk.convexClient.mutation(
        api.p2pSignaling.sendSignalingMessage,
        {
          lobbyId: this.currentConnection.lobbyId,
          toUserId: toUserId,
          messageType: message.type,
          data: message.data
        }
      );
      this.sdk.logger.debug('Sent signaling message:', message.type);
    } catch (error) {
      this.sdk.logger.error('Failed to send signaling message:', error);
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

      // Stop signaling message polling
      this.stopSignalingMessageSubscription();

      // Close all peer connections
      (Object.entries(this.currentConnection.peers) as [Id<"users">, P2PPeer][]).forEach(([userId, _]) => {
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
    
    const reliableReady = !this.config.enableReliableChannel || (reliableChannel?.readyState === 'open');
    const unreliableReady = !this.config.enableUnreliableChannel || (unreliableChannel?.readyState === 'open');
    
    return reliableReady && unreliableReady;
  }

  isBroadcastReady(): boolean {
    if (!this.currentConnection) return false;
    return this.reliableChannels.size > 0 && this.unreliableChannels.size > 0;
  }

  // Get status of all peer connections
  getPeerStatuses(): Record<Id<"users">, { reliable?: string; unreliable?: string; ready: boolean }> {
    if (!this.currentConnection) return {};
    
    const statuses: Record<Id<"users">, { reliable?: string; unreliable?: string; ready: boolean }> = {};
    
    for (const userId of Object.keys(this.currentConnection.peers) as Id<"users">[]) {
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
      for (let channel = 0; channel < this.MAX_CHANNELS; channel++) {
        this.createChannelQueue(channel);
      }
      
      this.sdk.logger.debug(`Initialized ${this.MAX_CHANNELS} SharedArrayBuffer P2P message queues`);
    } catch (error) {
      this.sdk.logger.warn('SharedArrayBuffer not supported');
      // Fallback to signal-based notifications
    }
  }

  private createChannelQueue(channel: number): void {
    // Total size: 2 headers + 2 data sections (bidirectional)
    const queueDataSize = this.MESSAGE_SIZE * this.QUEUE_SIZE;
    const totalSize = (this.HEADER_SIZE * 2) + (queueDataSize * 2);
    const buffer = new SharedArrayBuffer(totalSize);
    
    // Layout: [Incoming Header][Outgoing Header][Incoming Data][Outgoing Data]
    const incomingHeaderView = new Int32Array(buffer, 0, 4);
    const outgoingHeaderView = new Int32Array(buffer, this.HEADER_SIZE, 4);
    const incomingDataView = new Uint8Array(buffer, this.HEADER_SIZE * 2, queueDataSize);
    const outgoingDataView = new Uint8Array(buffer, (this.HEADER_SIZE * 2) + queueDataSize, queueDataSize);
    
    // Initialize both queue headers
    // Incoming queue (P2P network → Game engine)
    incomingHeaderView[0] = 0; // writeIndex
    incomingHeaderView[1] = 0; // readIndex  
    incomingHeaderView[2] = 0; // messageCount
    incomingHeaderView[3] = 1; // version
    
    // Outgoing queue (Game engine → P2P network)
    outgoingHeaderView[0] = 0; // writeIndex
    outgoingHeaderView[1] = 0; // readIndex  
    outgoingHeaderView[2] = 0; // messageCount
    outgoingHeaderView[3] = 1; // version
    
    this.channelQueues.set(channel, {
      buffer,
      incomingHeaderView,
      incomingDataView,
      outgoingHeaderView,
      outgoingDataView
    });
    
    // Expose to global scope for Godot access
    // if (typeof window !== 'undefined') {
    //   if (!(window as any).WavedashP2PChannelQueues) {
    //     (window as any).WavedashP2PChannelQueues = {};
    //   }
    //   (window as any).WavedashP2PChannelQueues[channel] = buffer;
    // }
  }

  // private enqueueMessage(message: P2PMessage): void {
  //   const channel = message.channel;
    
  //   // Create channel queue if it doesn't exist
  //   if (!this.channelQueues.has(channel)) {
  //     if (channel >= this.MAX_CHANNELS) {
  //       this.sdk.logger.warn(`Channel ${channel} exceeds max channels (${this.MAX_CHANNELS}), dropping message`);
  //       return;
  //     }
  //     this.createChannelQueue(channel);
  //   }

  //   const queue = this.channelQueues.get(channel)!;

  //   try {
  //     // Encode message to binary
  //     const messageData = this.encodeBinaryMessage(message);
  //     if (messageData.byteLength > this.MESSAGE_SIZE - 4) { // -4 for size prefix
  //       this.sdk.logger.warn(`Message too large for queue: ${messageData.byteLength} > ${this.MESSAGE_SIZE - 4}`);
  //       return;
  //     }

  //     // Get current queue state (atomic reads) - using incoming queue
  //     const writeIndex = Atomics.load(queue.incomingHeaderView, 0);
  //     const messageCount = Atomics.load(queue.incomingHeaderView, 2);

  //     // Check if queue is full
  //     if (messageCount >= this.QUEUE_SIZE) {
  //       this.sdk.logger.warn(`P2P message queue full for channel ${channel}, dropping message`);
  //       return;
  //     }

  //     // Calculate write position in the incoming data buffer
  //     const writeOffset = writeIndex * this.MESSAGE_SIZE;
      
  //     // Write message size at the beginning of the slot
  //     const incomingDataOffset = this.HEADER_SIZE * 2; // Skip both headers
  //     const slotView = new DataView(queue.buffer, incomingDataOffset + writeOffset, this.MESSAGE_SIZE);
  //     slotView.setUint32(0, messageData.byteLength, true);
      
  //     // Write message data
  //     const messageBytes = new Uint8Array(messageData);
  //     queue.incomingDataView.set(messageBytes, writeOffset + 4);

  //     // Update queue pointers atomically
  //     const nextWriteIndex = (writeIndex + 1) % this.QUEUE_SIZE;
  //     Atomics.store(queue.incomingHeaderView, 0, nextWriteIndex); // writeIndex
  //     Atomics.add(queue.incomingHeaderView, 2, 1); // messageCount++
      
  //     // Notify waiting readers (Game engine side)
  //     Atomics.notify(queue.incomingHeaderView, 2, 1);
      
  //   } catch (error) {
  //     this.sdk.logger.error(`Error enqueuing P2P message on channel ${channel}:`, error);
  //   }
  // }

  private enqueueBinaryMessage(binaryData: ArrayBuffer): void {
    try {
      // Extract channel from the binary data to determine which queue to use
      if (binaryData.byteLength < this.CHANNEL_OFFSET + this.CHANNEL_SIZE) {
        this.sdk.logger.warn('Binary message too short to extract channel');
        return;
      }

      const view = new DataView(binaryData);
      const channel = view.getUint32(this.CHANNEL_OFFSET, true);
      
      // Create channel queue if it doesn't exist
      if (!this.channelQueues.has(channel)) {
        if (channel >= this.MAX_CHANNELS) {
          this.sdk.logger.warn(`Channel ${channel} exceeds max channels (${this.MAX_CHANNELS}), dropping message`);
          return;
        }
        this.createChannelQueue(channel);
      }

      const queue = this.channelQueues.get(channel)!;

      // Get current queue state (atomic reads) - using incoming queue  
      const writeIndex = Atomics.load(queue.incomingHeaderView, 0);
      const messageCount = Atomics.load(queue.incomingHeaderView, 2);

      // Check if queue is full
      if (messageCount >= this.QUEUE_SIZE) {
        this.sdk.logger.warn(`P2P message queue full for channel ${channel}, dropping message`);
        return;
      }

      // Check if message fits
      if (binaryData.byteLength > this.MESSAGE_SIZE - 4) { // -4 for size prefix
        this.sdk.logger.warn(`Message too large for queue: ${binaryData.byteLength} > ${this.MESSAGE_SIZE - 4}`);
        return;
      }

      // Calculate write position in the incoming data buffer
      const writeOffset = writeIndex * this.MESSAGE_SIZE;
      
      // Write message size at the beginning of the slot
      const incomingDataOffset = this.HEADER_SIZE * 2; // Skip both headers
      const slotView = new DataView(queue.buffer, incomingDataOffset + writeOffset, this.MESSAGE_SIZE);
      slotView.setUint32(0, binaryData.byteLength, true);
      
      // Write raw binary message data
      const messageBytes = new Uint8Array(binaryData);
      queue.incomingDataView.set(messageBytes, writeOffset + 4);

      // Update queue pointers atomically
      const nextWriteIndex = (writeIndex + 1) % this.QUEUE_SIZE;
      Atomics.store(queue.incomingHeaderView, 0, nextWriteIndex); // writeIndex
      Atomics.add(queue.incomingHeaderView, 2, 1); // messageCount++
      
      // Notify waiting readers (Game engine side)
      Atomics.notify(queue.incomingHeaderView, 2, 1);
      
    } catch (error) {
      this.sdk.logger.error(`Error enqueuing binary P2P message:`, error);
    }
  }

  // Public method to get queue info for debugging
  getMessageQueueInfo(): { channels: number; queueSize: number; messageSize: number; totalSize: number } {
    const totalSize = this.channelQueues.size * (this.HEADER_SIZE + (this.MESSAGE_SIZE * this.QUEUE_SIZE));
    
    return {
      channels: this.channelQueues.size,
      queueSize: this.QUEUE_SIZE,
      messageSize: this.MESSAGE_SIZE,
      totalSize: totalSize
    };
  }

  // Get SharedArrayBuffer for specific channel (for game engine to access directly)
  getChannelQueueBuffer(channel: number): SharedArrayBuffer | null {
    const queue = this.channelQueues.get(channel);
    return queue ? queue.buffer : null;
  }

  // Read one message from outgoing queue for a specific channel
  // TODO Calvin: Confirm that the message pulled from the queue matches the intended recipient for the call to sendP2PMessage
  private readFromOutgoingQueue(channel: number): Uint8Array | null {
    const queue = this.channelQueues.get(channel);
    if (!queue) {
      return null;
    }

    const messageCount = Atomics.load(queue.outgoingHeaderView, 2);
    if (messageCount === 0) {
      return null; // No messages available
    }

    const readIndex = Atomics.load(queue.outgoingHeaderView, 1);
    const readOffset = readIndex * this.MESSAGE_SIZE;
    const outgoingDataOffset = (this.HEADER_SIZE * 2) + (this.MESSAGE_SIZE * this.QUEUE_SIZE);
    
    // Read message size
    const slotView = new DataView(queue.buffer, outgoingDataOffset + readOffset, this.MESSAGE_SIZE);
    const messageSize = slotView.getUint32(0, true);
    
    if (messageSize === 0 || messageSize > this.MESSAGE_SIZE - 4) {
      return null; // Invalid message
    }
    
    // Update read pointer atomically
    const nextReadIndex = (readIndex + 1) % this.QUEUE_SIZE;
    Atomics.store(queue.outgoingHeaderView, 1, nextReadIndex); // readIndex
    Atomics.sub(queue.outgoingHeaderView, 2, 1); // messageCount--

    // WebRTC refuses to send from SharedArrayBuffer directly so we need to make a copy
    const messageData = new Uint8Array(messageSize);
    const sourceView = new Uint8Array(queue.buffer, outgoingDataOffset + readOffset + 4, messageSize);
    messageData.set(sourceView);
    
    return messageData;
  }

  // ================
  // Binary Message Encoding/Decoding
  // ================

  private encodeBinaryMessage(message: P2PMessage): Uint8Array {
    // Binary format: [fromUserId(32)][channel(4)][dataLength(4)][payload(...)]
    const fromUserIdBytes = new TextEncoder().encode(message.fromUserId).slice(0, this.USERID_SIZE);
    const payloadBytes = message.payload instanceof ArrayBuffer ? new Uint8Array(message.payload) : new Uint8Array(0);
    
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

  private decodeBinaryMessage(data: ArrayBuffer): P2PMessage {
    if (data.byteLength < this.PAYLOAD_OFFSET) {
      throw new Error('Invalid binary message: too short');
    }
    
    const view = new DataView(data);
    const uint8View = new Uint8Array(data);
    
    let offset = 0;
    
    // fromUserId (32 bytes)
    const fromUserIdBytes = uint8View.slice(offset, offset + this.USERID_SIZE);
    const fromUserId = new TextDecoder().decode(fromUserIdBytes).replace(/\0+$/, '') as Id<"users">;
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