/**
 * P2P networking service
 * 
 * Handles WebRTC peer-to-peer connections for lobbies with integer peer handles
 */

import type {
  Id,
  WavedashResponse,
  P2PPeer,
  P2PConnection,
  P2PConnectionState,
  P2PMessage,
  P2PSignalingMessage,
  P2PConfig,
  WavedashUser,
} from '../types';
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

import { Signals } from '../signals';

export class P2PManager {
  private sdk: WavedashSDK;
  private currentConnection: P2PConnection | null = null;
  private peerConnections = new Map<Id<"users">, RTCPeerConnection>();
  private reliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private unreliableChannels = new Map<Id<"users">, RTCDataChannel>();
  private config: P2PConfig;
  private messageCallback: ((message: P2PMessage) => void) | null = null;
  private processedSignalingMessages = new Set<string>(); // Track processed message IDs

  constructor(sdk: WavedashSDK, config?: Partial<P2PConfig>) {
    this.sdk = sdk;
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
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
      try {
        const message: P2PMessage = JSON.parse(event.data);
        this.handleIncomingP2PMessage(message);
      } catch (error) {
        // Handle binary data
        this.handleIncomingP2PMessage({
          fromUserId: remoteUserId,
          channel: 0, // Default channel for binary data
          data: event.data,
          timestamp: Date.now()
        });
      }
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

  async sendP2PMessage(toUserId: Id<"users"> | undefined, data: ArrayBuffer, reliable: boolean = true): Promise<WavedashResponse<boolean>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No active P2P connection');
      }

      const message: P2PMessage = {
        fromUserId: this.sdk.getUserId(),
        toUserId: toUserId,
        channel: 0, // Default channel for now, can add app-level channels later
        data,
        timestamp: Date.now()
      };

      // TODO Calvin: This should be a binary message instead of JSON
      const messageData = JSON.stringify(message);
      const channelMap = reliable ? this.reliableChannels : this.unreliableChannels;

      if (toUserId === undefined) {
        // Broadcast to all peers
        channelMap.forEach((channel) => {
          if (channel.readyState === 'open') {
            channel.send(messageData);
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toUserId);
        if (!channel || channel.readyState !== 'open') {
          throw new Error(`No open channel to peer ${toUserId}`);
        }
        channel.send(messageData);
      }

      return {
        success: true,
        data: true,
        args: { toUserId, reliable }
      };
    } catch (error) {
      this.sdk.logger.error(`Error sending P2P message:`, error);
      return {
        success: false,
        data: false,
        args: { toUserId, reliable },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  // ==================
  // Message Receiving
  // ==================

  private handleIncomingP2PMessage(message: P2PMessage): void {
    // Notify the game through engine callbacks if available
    this.sdk.notifyGame(Signals.P2P_MESSAGE, message);

    // Notify web applications through callback
    if (this.messageCallback) {
      this.messageCallback(message);
    }
  }

  // ===============
  // Signaling
  // ===============

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
}