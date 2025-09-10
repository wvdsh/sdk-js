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
    // TODO: Add TURN servers for relay fallback
  ],
  maxPeers: 8,
  enableReliableChannel: true,
  enableUnreliableChannel: true,
};

export class P2PManager {
  private sdk: WavedashSDK;
  private currentConnection: P2PConnection | null = null;
  private peerConnections = new Map<number, RTCPeerConnection>();
  private reliableChannels = new Map<number, RTCDataChannel>();
  private unreliableChannels = new Map<number, RTCDataChannel>();
  private config: P2PConfig;

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
        peers: new Map(),
        state: "connecting"
      };

      // Populate peers map
      peerAssignments.forEach((handle, userId) => {
        const member = members.find(m => m.id === userId);
        if (member) {
          connection.peers.set(handle, {
            handle,
            userId: member.id,
            username: member.username,
            isHost: false // TODO: Determine host from lobby data
          });
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
    // Send peer assignments to all lobby members
    await this.sendPeerAssignments(connection);

    // Start polling for signaling messages
    this.startSignalingMessagePolling(connection);

    // Create peer connections for each remote peer
    const promises: Promise<void>[] = [];
    connection.peers.forEach((peer, handle) => {
      if (handle !== connection.localHandle) {
        promises.push(this.createPeerConnection(handle, connection));
      }
    });

    await Promise.all(promises);

    // Start the WebRTC negotiation process
    await this.initiateWebRTCNegotiation(connection);
    
    connection.state = "connected";
  }

  private async sendPeerAssignments(connection: P2PConnection): Promise<void> {
    const assignments: Record<string, number> = {};
    connection.peers.forEach((peer, handle) => {
      assignments[peer.userId] = handle;
    });

    await this.sendSignalingMessage({
      type: P2P_SIGNALING_MESSAGE_TYPE.PEER_ASSIGNMENTS,
      data: assignments
    });
  }

  private signalingInterval: number | null = null;

  private startSignalingMessagePolling(connection: P2PConnection): void {
    // Poll for signaling messages every 1 second
    this.signalingInterval = window.setInterval(async () => {
      try {
        await this.pollSignalingMessages(connection);
      } catch (error) {
        this.sdk.logger.error('Error polling signaling messages:', error);
      }
    }, 1000);
  }

  private stopSignalingMessagePolling(): void {
    if (this.signalingInterval !== null) {
      window.clearInterval(this.signalingInterval);
      this.signalingInterval = null;
    }
  }

  private async pollSignalingMessages(connection: P2PConnection): Promise<void> {
    const messages = await this.sdk.convexClient.query(
      api.p2pSignaling.getSignalingMessages,
      { lobbyId: connection.lobbyId }
    );

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
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await this.sendSignalingMessage({
          type: P2P_SIGNALING_MESSAGE_TYPE.ANSWER,
          toHandle: remoteHandle,
          data: answer
        });
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ANSWER:
        await pc.setRemoteDescription(new RTCSessionDescription(message.data));
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE:
        await pc.addIceCandidate(new RTCIceCandidate(message.data));
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.PEER_ASSIGNMENTS:
        // Update peer assignments from host
        this.updatePeerAssignments(message.data, connection);
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.PEER_JOINED:
        // Handle new peer joining mid-game
        await this.handlePeerJoined(message.data, connection);
        break;

      case P2P_SIGNALING_MESSAGE_TYPE.PEER_LEFT:
        // Handle peer leaving mid-game
        await this.handlePeerLeft(message.data, connection);
        break;

      default:
        this.sdk.logger.warn('Unknown signaling message type:', message.messageType);
    }
  }

  private updatePeerAssignments(assignments: Record<string, number>, connection: P2PConnection): void {
    // Clear existing peer mappings
    connection.peers.clear();

    // Rebuild peer mappings from assignments
    Object.entries(assignments).forEach(([userId, handle]) => {
      // TODO: Get user details from somewhere - maybe cache from lobby members?
      connection.peers.set(handle, {
        handle,
        userId: userId as Id<"users">,
        username: 'Unknown', // TODO: Look up username
        isHost: false // TODO: Determine host
      });
    });

    connection.localHandle = assignments[this.sdk.getUserId()];
  }

  private async handlePeerJoined(data: { newPeerHandle: number, userId: Id<"users">, username: string }, connection: P2PConnection): Promise<void> {
    this.sdk.logger.debug('Peer joined:', data);
    
    // Add new peer to connection
    connection.peers.set(data.newPeerHandle, {
      handle: data.newPeerHandle,
      userId: data.userId,
      username: data.username,
      isHost: false
    });

    // Create new peer connection for the joined peer
    await this.createPeerConnection(data.newPeerHandle, connection);

    // If we're the host, initiate offer to new peer
    const isHost = connection.peers.get(connection.localHandle)?.isHost;
    if (isHost) {
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
    connection.peers.delete(leftHandle);
  }

  private async initiateWebRTCNegotiation(connection: P2PConnection): Promise<void> {
    // Only the host initiates offers to avoid conflicts
    const isHost = connection.peers.get(connection.localHandle)?.isHost;
    if (!isHost) return;

    const offers: Promise<void>[] = [];
    
    connection.peers.forEach((peer, handle) => {
      if (handle !== connection.localHandle) {
        offers.push(this.createOfferToPeer(handle));
      }
    });

    await Promise.all(offers);
  }

  private async createOfferToPeer(remoteHandle: number): Promise<void> {
    const pc = this.peerConnections.get(remoteHandle);
    if (!pc) {
      throw new Error(`No peer connection for handle ${remoteHandle}`);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.sendSignalingMessage({
      type: P2P_SIGNALING_MESSAGE_TYPE.OFFER,
      toHandle: remoteHandle,
      data: offer
    });
  }

  private async createPeerConnection(remoteHandle: number, connection: P2PConnection): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.config.iceServers
    });

    // Set up data channels
    if (this.config.enableReliableChannel) {
      const reliableChannel = pc.createDataChannel('reliable', {
        ordered: true,
        maxRetransmits: 3
      });
      this.reliableChannels.set(remoteHandle, reliableChannel);
      this.setupDataChannelHandlers(reliableChannel, remoteHandle, 'reliable');
    }

    if (this.config.enableUnreliableChannel) {
      const unreliableChannel = pc.createDataChannel('unreliable', {
        ordered: false,
        maxRetransmits: 0
      });
      this.unreliableChannels.set(remoteHandle, unreliableChannel);
      this.setupDataChannelHandlers(unreliableChannel, remoteHandle, 'unreliable');
    }

    // Set up peer connection event handlers
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: P2P_SIGNALING_MESSAGE_TYPE.ICE_CANDIDATE,
          fromHandle: connection.localHandle,
          toHandle: remoteHandle,
          data: event.candidate
        });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      this.setupDataChannelHandlers(channel, remoteHandle, channel.label as 'reliable' | 'unreliable');
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

  async sendP2PMessage(toHandle: number | undefined, channel: number, data: any, reliable: boolean = true): Promise<WavedashResponse<boolean>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No active P2P connection');
      }

      const message: P2PMessage = {
        fromHandle: this.currentConnection.localHandle,
        toHandle,
        channel,
        data,
        timestamp: Date.now()
      };

      const messageData = JSON.stringify(message);
      const channelMap = reliable ? this.reliableChannels : this.unreliableChannels;

      if (toHandle === undefined) {
        // Broadcast to all peers
        const sendPromises: Promise<void>[] = [];
        channelMap.forEach((channel, handle) => {
          if (channel.readyState === 'open') {
            sendPromises.push(this.sendToChannel(channel, messageData));
          }
        });
        await Promise.all(sendPromises);
      } else {
        // Send to specific peer
        const channel = channelMap.get(toHandle);
        if (!channel || channel.readyState !== 'open') {
          throw new Error(`No open channel to peer ${toHandle}`);
        }
        await this.sendToChannel(channel, messageData);
      }

      return {
        success: true,
        data: true,
        args: { toHandle, channel, reliable }
      };
    } catch (error) {
      this.sdk.logger.error(`Error sending P2P message:`, error);
      return {
        success: false,
        data: false,
        args: { toHandle, channel, reliable },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async sendGameData(toHandle: number | undefined, channel: number, data: ArrayBuffer): Promise<WavedashResponse<boolean>> {
    try {
      if (!this.currentConnection) {
        throw new Error('No active P2P connection');
      }

      const channelMap = this.unreliableChannels; // Game data uses unreliable channel

      if (toHandle === undefined) {
        // Broadcast to all peers
        const sendPromises: Promise<void>[] = [];
        channelMap.forEach((channel, handle) => {
          if (channel.readyState === 'open') {
            sendPromises.push(this.sendToChannel(channel, data));
          }
        });
        await Promise.all(sendPromises);
      } else {
        // Send to specific peer
        const channel = channelMap.get(toHandle);
        if (!channel || channel.readyState !== 'open') {
          throw new Error(`No open channel to peer ${toHandle}`);
        }
        await this.sendToChannel(channel, data);
      }

      return {
        success: true,
        data: true,
        args: { toHandle, channel }
      };
    } catch (error) {
      this.sdk.logger.error(`Error sending game data:`, error);
      return {
        success: false,
        data: false,
        args: { toHandle, channel },
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async sendToChannel(channel: RTCDataChannel, data: string | ArrayBuffer): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        channel.send(data as any); // RTCDataChannel.send accepts string | ArrayBuffer
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  }

  // ==================
  // Message Receiving
  // ==================

  private handleIncomingP2PMessage(message: P2PMessage): void {
    // Notify the game through engine callbacks if available
    if (this.sdk.engineInstance) {
      this.sdk.engineInstance.SendMessage(
        this.sdk.engineCallbackReceiver,
        'P2PMessageReceived',
        JSON.stringify(message)
      );
    }

    // TODO: Add callback system for web applications
  }

  // ===============
  // Signaling
  // ===============

  private async sendSignalingMessage(message: P2PSignalingMessage): Promise<void> {
    if (!this.currentConnection) {
      throw new Error('No active P2P connection for signaling');
    }

    try {
      await this.sdk.convexClient.mutation(
        api.p2pSignaling.sendSignalingMessage,
        {
          lobbyId: this.currentConnection.lobbyId,
          toUserId: message.toHandle ? this.getPeerUserId(message.toHandle) : undefined,
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

  private getPeerUserId(handle: number): Id<"users"> | undefined {
    if (!this.currentConnection) return undefined;
    const peer = this.currentConnection.peers.get(handle);
    return peer?.userId;
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
      this.stopSignalingMessagePolling();

      // Close all peer connections
      this.currentConnection.peers.forEach((_, handle) => {
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
    return this.currentConnection?.peers.get(handle) || null;
  }

  getUserHandle(userId: Id<"users">): number | null {
    if (!this.currentConnection) return null;

    for (const [handle, peer] of this.currentConnection.peers) {
      if (peer.userId === userId) {
        return handle;
      }
    }
    return null;
  }

  updateConfig(config: Partial<P2PConfig>): void {
    this.config = { ...this.config, ...config };
  }
}