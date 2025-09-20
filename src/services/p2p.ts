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
  private peerConnections = new Map<number, RTCPeerConnection>();
  private reliableChannels = new Map<number, RTCDataChannel>();
  private unreliableChannels = new Map<number, RTCDataChannel>();
  private config: P2PConfig;
  private messageCallback: ((message: P2PMessage) => void) | null = null;

  constructor(sdk: WavedashSDK, config?: Partial<P2PConfig>) {
    this.sdk = sdk;
    this.config = { ...DEFAULT_P2P_CONFIG, ...config };
  }

  // ================
  // Connection Setup
  // ================

  async initializeP2PForCurrentLobby(lobbyId: Id<"lobbies">, members: WavedashUser[]): Promise<WavedashResponse<P2PConnection>> {
    try {
      // Generate consistent peer handle assignments
      const peerAssignments = this.generatePeerHandles(members);
      const localHandle = peerAssignments.get(this.sdk.getUserId());
      
      if (!localHandle) {
        throw new Error('Local user not found in lobby members');
      }

      // Create P2P connection state
      const connection: P2PConnection = {
        lobbyId,
        localHandle,
        peers: {},
        state: "connecting"
      };

      // Populate peers object (excluding local peer)
      peerAssignments.forEach((handle, userId) => {
        const member = members.find(m => m.id === userId);
        if (member && userId !== this.sdk.getUserId()) {
          connection.peers[handle] = {
            handle,
            userId: member.id,
            username: member.username,
            isHost: false // TODO: Determine host from lobby data
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

  private generatePeerHandles(members: WavedashUser[]): Map<Id<"users">, number> {
    const assignments = new Map<Id<"users">, number>();
    
    // Sort members by user ID for consistent ordering across all peers
    const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id));
    
    // Assign handles starting from 1
    sortedMembers.forEach((member, index) => {
      assignments.set(member.id, index + 1);
    });

    return assignments;
  }

  private async establishWebRTCConnections(connection: P2PConnection): Promise<void> {
    // Subscribe to real-time signaling message updates
    this.subscribeToSignalingMessages(connection);

    // Establish WebRTC connections immediately (no need to wait for assignments)
    await this.establishPeerConnections(connection);

    connection.state = "connecting";
  }


  private unsubscribeFromSignalingMessages: (() => void) | null = null;

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

    const messageIds: Id<"p2pSignalingMessages">[] = [];

    for (const message of messages) {
      try {
        await this.handleSignalingMessage(message, connection);
        messageIds.push(message._id);
      } catch (error) {
        this.sdk.logger.error('Error handling signaling message:', error);
      }
    }

    // Mark messages as processed
    if (messageIds.length > 0) {
      await this.sdk.convexClient.mutation(
        api.p2pSignaling.markSignalingMessagesProcessed,
        { messageIds }
      );
    }
  }

  private async handleSignalingMessage(message: any, connection: P2PConnection): Promise<void> {
    // Skip messages from ourselves
    if (message.fromUserId === this.sdk.getUserId()) {
      return;
    }

    const remoteHandle = this.getUserHandle(message.fromUserId);
    if (!remoteHandle) {
      this.sdk.logger.warn('Received signaling message from unknown user:', message.fromUserId);
      return;
    }

    const pc = this.peerConnections.get(remoteHandle);
    if (!pc) {
      this.sdk.logger.warn('No peer connection for handle:', remoteHandle);
      return;
    }

    switch (message.messageType) {
      case P2P_SIGNALING_MESSAGE_TYPE.OFFER:
        // Log offer processing details
        const hasDataChannelInOffer = message.data.sdp?.includes('m=application');
        this.sdk.logger.debug(`Processing offer from peer ${remoteHandle}:`);
        this.sdk.logger.debug(`  Offer contains data channels: ${hasDataChannelInOffer}`);
        
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        this.sdk.logger.debug(`  Answer created, waiting for ondatachannel events...`);
        
        // Convert RTCSessionDescription to plain object for Convex
        const answerData = {
          type: answer.type,
          sdp: answer.sdp
        };
        
        await this.sendSignalingMessage({
          type: P2P_SIGNALING_MESSAGE_TYPE.ANSWER,
          toHandle: remoteHandle,
          data: answerData
        });
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ANSWER:
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE:
        await pc.addIceCandidate(new RTCIceCandidate(message.data));
        break;

      // case P2P_SIGNALING_MESSAGE_TYPE.PEER_JOINED:
      //   // Handle new peer joining mid-game
      //   await this.handlePeerJoined(message.data, connection);
      //   break;

      // case P2P_SIGNALING_MESSAGE_TYPE.PEER_LEFT:
      //   // Handle peer leaving mid-game
      //   await this.handlePeerLeft(message.data, connection);
      //   break;

      default:
        this.sdk.logger.warn('Unknown signaling message type:', message.messageType);
    }
  }


  private async establishPeerConnections(connection: P2PConnection): Promise<void> {
    this.sdk.logger.debug('Establishing WebRTC connections to peers...');

    const connectionPromises: Promise<void>[] = [];
    
    // Create peer connections to all other peers
    Object.entries(connection.peers).forEach(([handleStr, peer]) => {
      const handle = parseInt(handleStr);
      if (handle !== connection.localHandle) {
        // Only create channels if we're the lower handle (we'll initiate the offer)
        const shouldCreateChannels = connection.localHandle < handle;
        this.sdk.logger.debug(`Creating connection to peer ${handle} (${peer.username}), shouldCreateChannels: ${shouldCreateChannels}`);
        connectionPromises.push(this.createPeerConnection(handle, connection, shouldCreateChannels));
      }
    });

    // Wait for all connections to be created first
    await Promise.all(connectionPromises);
    
    // Small delay to ensure data channels are properly set up before creating offers
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Then initiate offers (lower handle number initiates to prevent conflicts)
    const offerPromises: Promise<void>[] = [];
    Object.keys(connection.peers).forEach(handleStr => {
      const handle = parseInt(handleStr);
      if (handle !== connection.localHandle && connection.localHandle < handle) {
        this.sdk.logger.debug(`Initiating offer to peer ${handle}`);
        offerPromises.push(this.createOfferToPeer(handle));
      }
    });
    
    await Promise.all(offerPromises);
    this.sdk.logger.debug(`Created ${connectionPromises.length} peer connections, initiated ${offerPromises.length} offers`);
  }

  private async handlePeerJoined(data: { newPeerHandle: number, userId: Id<"users">, username: string }, connection: P2PConnection): Promise<void> {
    this.sdk.logger.debug('Peer joined:', data);
    
    // Add new peer to connection
    connection.peers[data.newPeerHandle] = {
      handle: data.newPeerHandle,
      userId: data.userId,
      username: data.username,
      isHost: false
    };

    // Create new peer connection for the joined peer
    // If we have lower handle, we create channels and initiate offer
    const shouldCreateChannels = connection.localHandle < data.newPeerHandle;
    await this.createPeerConnection(data.newPeerHandle, connection, shouldCreateChannels);

    // If we have lower handle, initiate offer to new peer
    if (shouldCreateChannels) {
      await this.createOfferToPeer(data.newPeerHandle);
    }
  }

  private async handlePeerLeft(data: { leftPeerHandle: number }, connection: P2PConnection): Promise<void> {
    this.sdk.logger.debug('Peer left:', data);
    
    const leftHandle = data.leftPeerHandle;
    
    // Close peer connection
    const pc = this.peerConnections.get(leftHandle);
    if (pc) {
      pc.close();
      this.peerConnections.delete(leftHandle);
    }

    // Clean up data channels
    this.reliableChannels.delete(leftHandle);
    this.unreliableChannels.delete(leftHandle);

    // Remove from connection peers
    delete connection.peers[leftHandle];
  }


  private async createOfferToPeer(remoteHandle: number): Promise<void> {
    const pc = this.peerConnections.get(remoteHandle);
    if (!pc) {
      throw new Error(`No peer connection for handle ${remoteHandle}`);
    }

    // Log channel states before creating offer
    const reliableChannel = this.reliableChannels.get(remoteHandle);
    const unreliableChannel = this.unreliableChannels.get(remoteHandle);
    this.sdk.logger.debug(`Creating offer to peer ${remoteHandle}:`);
    this.sdk.logger.debug(`  Reliable channel state: ${reliableChannel?.readyState || 'none'}`);
    this.sdk.logger.debug(`  Unreliable channel state: ${unreliableChannel?.readyState || 'none'}`);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Log if SDP contains data channels
    const hasDataChannel = offer.sdp?.includes('m=application');
    this.sdk.logger.debug(`  Offer includes data channels: ${hasDataChannel}`);

    // Convert RTCSessionDescription to plain object for Convex
    const offerData = {
      type: offer.type,
      sdp: offer.sdp
    };

    await this.sendSignalingMessage({
      type: P2P_SIGNALING_MESSAGE_TYPE.OFFER,
      toHandle: remoteHandle,
      data: offerData
    });
  }

  private async createPeerConnection(remoteHandle: number, connection: P2PConnection, shouldCreateChannels: boolean = false): Promise<void> {
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
      this.sdk.logger.debug(`Creating data channels for peer ${remoteHandle}`);
      
      if (this.config.enableReliableChannel) {
        const reliableChannel = pc.createDataChannel('reliable', {
          ordered: true,
          maxRetransmits: undefined // Full reliability, will retransmit until received
        });
        this.reliableChannels.set(remoteHandle, reliableChannel);
        this.setupDataChannelHandlers(reliableChannel, remoteHandle, 'reliable');
      }

      if (this.config.enableUnreliableChannel) {
        const unreliableChannel = pc.createDataChannel('unreliable', {
          ordered: false,
          maxRetransmits: 0, // No retransmits, will drop if not received
        });
        this.unreliableChannels.set(remoteHandle, unreliableChannel);
        this.setupDataChannelHandlers(unreliableChannel, remoteHandle, 'unreliable');
      }
    } else {
      this.sdk.logger.debug(`Will receive data channels from peer ${remoteHandle} via ondatachannel`);
    }

    // Set up peer connection event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // Log candidate type for debugging
        const candidateType = event.candidate.candidate.includes('typ host') ? 'host' :
                             event.candidate.candidate.includes('typ srflx') ? 'srflx (STUN)' :
                             event.candidate.candidate.includes('typ relay') ? 'relay (TURN)' : 'unknown';
        
        this.sdk.logger.debug(`Peer ${remoteHandle} gathered ICE candidate: ${candidateType}`);
        this.sdk.logger.debug(`  Candidate: ${event.candidate.candidate}`);
        
        // Convert RTCIceCandidate to a plain object for Convex serialization
        const candidateData = {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment
        };
        
        this.sendSignalingMessage({
          type: P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE,
          fromHandle: connection.localHandle,
          toHandle: remoteHandle,
          data: candidateData
        });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      this.sdk.logger.debug(`Received ${channel.label} data channel from peer ${remoteHandle}`);
      
      // Store the received channel in the appropriate map
      if (channel.label === 'reliable') {
        this.reliableChannels.set(remoteHandle, channel);
      } else if (channel.label === 'unreliable') {
        this.unreliableChannels.set(remoteHandle, channel);
      }
      
      this.setupDataChannelHandlers(channel, remoteHandle, channel.label as 'reliable' | 'unreliable');
    };

    // Add connection state monitoring for debugging
    pc.onconnectionstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteHandle} connection state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') {
        this.sdk.logger.debug(`  Peer ${remoteHandle} fully connected, expecting ondatachannel events now...`);
      }
    };

    pc.oniceconnectionstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteHandle} ICE connection state: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        this.sdk.logger.debug(`  ICE connected to peer ${remoteHandle}, data channels should be available...`);
      }
    };

    pc.onicegatheringstatechange = () => {
      this.sdk.logger.debug(`Peer ${remoteHandle} ICE gathering state: ${pc.iceGatheringState}`);
    };

    this.peerConnections.set(remoteHandle, pc);

    // TODO: Implement actual WebRTC negotiation (offer/answer exchange)
    // This will require integration with Convex signaling server
  }

  private setupDataChannelHandlers(channel: RTCDataChannel, remoteHandle: number, type: 'reliable' | 'unreliable'): void {
    channel.onopen = () => {
      this.sdk.logger.debug(`${type} data channel opened with peer ${remoteHandle}`);
    };

    channel.onmessage = (event) => {
      try {
        const message: P2PMessage = JSON.parse(event.data);
        this.handleIncomingP2PMessage(message);
      } catch (error) {
        // Handle binary data
        this.handleIncomingP2PMessage({
          fromHandle: remoteHandle,
          channel: 0, // Default channel for binary data
          data: event.data,
          timestamp: Date.now()
        });
      }
    };

    channel.onerror = (error) => {
      this.sdk.logger.error(`Data channel error with peer ${remoteHandle}:`, error);
    };
  }

  // ================
  // Message Sending
  // ================

  async sendP2PMessage(toHandle: number | undefined, data: any, reliable: boolean = true): Promise<WavedashResponse<boolean>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No active P2P connection');
      }

      const message: P2PMessage = {
        fromHandle: this.currentConnection.localHandle,
        toHandle,
        channel: 0, // Default channel for now, can add app-level channels later
        data,
        timestamp: Date.now()
      };

      const messageData = JSON.stringify(message);
      const channelMap = reliable ? this.reliableChannels : this.unreliableChannels;

      if (toHandle === undefined) {
        // Broadcast to all peers
        channelMap.forEach((channel) => {
          if (channel.readyState === 'open') {
            channel.send(messageData);
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toHandle);
        if (!channel || channel.readyState !== 'open') {
          throw new Error(`No open channel to peer ${toHandle}`);
        }
        channel.send(messageData);
      }

      return {
        success: true,
        data: true,
        args: { toHandle, reliable }
      };
    } catch (error) {
      this.sdk.logger.error(`Error sending P2P message:`, error);
      return {
        success: false,
        data: false,
        args: { toHandle, reliable },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async sendGameData(toHandle: number | undefined, data: ArrayBuffer): Promise<WavedashResponse<boolean>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No active P2P connection');
      }

      const channelMap = this.unreliableChannels; // Game data uses unreliable channel

      if (toHandle === undefined) {
        // Broadcast to all peers
        channelMap.forEach((channel) => {
          if (channel.readyState === 'open') {
            channel.send(data);
          }
        });
      } else {
        // Send to specific peer
        const channel = channelMap.get(toHandle);
        if (!channel || channel.readyState !== 'open') {
          throw new Error(`No open channel to peer ${toHandle}`);
        }
        channel.send(data);
      }

      return {
        success: true,
        data: true,
        args: { toHandle }
      };
    } catch (error) {
      this.sdk.logger.error(`Error sending game data:`, error);
      return {
        success: false,
        data: false,
        args: { toHandle },
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

  private async sendSignalingMessage(message: P2PSignalingMessage): Promise<void> {
    if (!this.currentConnection) {
      throw new Error('No active P2P connection for signaling');
    }

    try {
      const toUserId = this.currentConnection.peers[message.toHandle].userId;
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

  async disconnectP2P(): Promise<WavedashResponse<boolean>> {
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
      Object.entries(this.currentConnection.peers).forEach(([handleStr, _]) => {
        const handle = Number(handleStr);
        if (handle !== this.currentConnection!.localHandle) {
          const pc = this.peerConnections.get(handle);
          if (pc) {
            pc.close();
            this.peerConnections.delete(handle);
          }

          this.reliableChannels.delete(handle);
          this.unreliableChannels.delete(handle);
        }
      });

      this.currentConnection = null;

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

  getPeerByHandle(handle: number): P2PPeer | null {
    return this.currentConnection?.peers[handle] || null;
  }

  getUserHandle(userId: Id<"users">): number | null {
    if (!this.currentConnection) return null;

    for (const [handleStr, peer] of Object.entries(this.currentConnection.peers)) {
      if (peer.userId === userId) {
        return Number(handleStr);
      }
    }
    return null;
  }

  updateConfig(config: Partial<P2PConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // Set callback for receiving P2P messages (for web applications)
  setMessageCallback(callback: ((message: P2PMessage) => void) | null): void {
    this.messageCallback = callback;
  }

  // Check if channels are ready for a specific peer
  isPeerReady(handle: number): boolean {
    if (!this.currentConnection) return false;
    
    const reliableChannel = this.reliableChannels.get(handle);
    const unreliableChannel = this.unreliableChannels.get(handle);
    
    const reliableReady = !this.config.enableReliableChannel || (reliableChannel?.readyState === 'open');
    const unreliableReady = !this.config.enableUnreliableChannel || (unreliableChannel?.readyState === 'open');
    
    return reliableReady && unreliableReady;
  }

  // Get status of all peer connections
  getPeerStatuses(): Record<number, { reliable?: string; unreliable?: string; ready: boolean }> {
    if (!this.currentConnection) return {};
    
    const statuses: Record<number, { reliable?: string; unreliable?: string; ready: boolean }> = {};
    
    for (const handle of Object.keys(this.currentConnection.peers).map(Number)) {
      const reliableChannel = this.reliableChannels.get(handle);
      const unreliableChannel = this.unreliableChannels.get(handle);
      
      statuses[handle] = {
        reliable: reliableChannel?.readyState,
        unreliable: unreliableChannel?.readyState,
        ready: this.isPeerReady(handle)
      };
    }
    
    return statuses;
  }
}