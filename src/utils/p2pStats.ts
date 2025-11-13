/**
 * P2P Stats Manager
 *
 * Tracks networking statistics for debugging purposes
 * Designed to be lightweight and have minimal performance impact
 */

import type { P2PStats } from "../types";

interface QueuedPacket {
  enqueuedAt: number;
  sizeBytes: number;
}

export class P2PStatsManager {
  private enabled: boolean = false;
  private queueSize: number;
  private maxChannels: number;

  // Timing tracking
  private queueWaitTimes: number[] = []; // Store recent wait times for averaging
  private maxWaitTimeMs: number = 0;
  private minWaitTimeMs: number = Infinity;

  // Size tracking
  private packetSizes: number[] = []; // Store recent packet sizes for averaging
  private maxPacketSize: number = 0;
  private minPacketSize: number = Infinity;

  // Counters
  private totalPacketsSent: number = 0;
  private totalPacketsReceived: number = 0;
  private totalBytesReceived: number = 0;

  // Per-channel tracking
  private channelMessageCounts: Map<number, number> = new Map();

  // Packet metadata for timing (channel -> packets)
  private packetMetadata: Map<number, QueuedPacket[]> = new Map();

  // Keep recent samples for rolling averages (limit memory usage)
  private readonly MAX_SAMPLES = 1000;

  constructor(queueSize: number, maxChannels: number) {
    this.queueSize = queueSize;
    this.maxChannels = maxChannels;
  }

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // Called when a packet is enqueued
  trackEnqueue(channel: number, sizeBytes: number): void {
    if (!this.enabled) return;

    // Track packet metadata for timing
    if (!this.packetMetadata.has(channel)) {
      this.packetMetadata.set(channel, []);
    }
    const packets = this.packetMetadata.get(channel)!;
    packets.push({
      enqueuedAt: performance.now(),
      sizeBytes,
    });

    // Update channel message count
    const currentCount = this.channelMessageCounts.get(channel) || 0;
    this.channelMessageCounts.set(channel, currentCount + 1);
  }

  // Called when a packet is dequeued
  trackDequeue(channel: number): void {
    if (!this.enabled) return;

    const packets = this.packetMetadata.get(channel);
    if (!packets || packets.length === 0) return;

    // Remove the oldest packet (FIFO)
    const packet = packets.shift()!;
    const waitTime = performance.now() - packet.enqueuedAt;

    // Update wait time stats
    this.queueWaitTimes.push(waitTime);
    if (this.queueWaitTimes.length > this.MAX_SAMPLES) {
      this.queueWaitTimes.shift();
    }
    this.maxWaitTimeMs = Math.max(this.maxWaitTimeMs, waitTime);
    if (waitTime > 0) {
      this.minWaitTimeMs = Math.min(this.minWaitTimeMs, waitTime);
    }

    // Update packet size stats
    this.packetSizes.push(packet.sizeBytes);
    if (this.packetSizes.length > this.MAX_SAMPLES) {
      this.packetSizes.shift();
    }
    this.maxPacketSize = Math.max(this.maxPacketSize, packet.sizeBytes);
    this.minPacketSize = Math.min(this.minPacketSize, packet.sizeBytes);

    // Update counters
    this.totalPacketsReceived++;
    this.totalBytesReceived += packet.sizeBytes;

    // Update channel message count
    const currentCount = this.channelMessageCounts.get(channel) || 0;
    this.channelMessageCounts.set(channel, Math.max(0, currentCount - 1));
  }

  // Called when a packet is sent
  trackSend(sizeBytes: number): void {
    if (!this.enabled) return;
    this.totalPacketsSent++;
  }

  // Get current stats snapshot
  getStats(): P2PStats {
    const channelStats: Record<number, { messagesInQueue: number; queueCapacity: number }> = {};
    
    // Build per-channel stats
    this.channelMessageCounts.forEach((count, channel) => {
      channelStats[channel] = {
        messagesInQueue: count,
        queueCapacity: this.queueSize,
      };
    });

    // Calculate averages
    const avgWaitTime = this.queueWaitTimes.length > 0
      ? this.queueWaitTimes.reduce((a, b) => a + b, 0) / this.queueWaitTimes.length
      : 0;

    const avgPacketSize = this.packetSizes.length > 0
      ? this.packetSizes.reduce((a, b) => a + b, 0) / this.packetSizes.length
      : 0;

    // Calculate total queue utilization
    const totalCurrentMessages = Array.from(this.channelMessageCounts.values()).reduce(
      (sum, count) => sum + count,
      0
    );
    const totalCapacity = this.channelMessageCounts.size * this.queueSize;
    const utilizationPercent = totalCapacity > 0 
      ? (totalCurrentMessages / totalCapacity) * 100 
      : 0;

    return {
      enabled: this.enabled,
      averageQueueWaitTimeMs: avgWaitTime,
      maxQueueWaitTimeMs: this.maxWaitTimeMs,
      minQueueWaitTimeMs: this.minWaitTimeMs === Infinity ? 0 : this.minWaitTimeMs,
      currentQueueSize: totalCurrentMessages,
      maxQueueSize: totalCapacity,
      queueUtilizationPercent: utilizationPercent,
      averagePacketSizeBytes: avgPacketSize,
      maxPacketSizeBytes: this.maxPacketSize,
      minPacketSizeBytes: this.minPacketSize === Infinity ? 0 : this.minPacketSize,
      totalPacketsSent: this.totalPacketsSent,
      totalPacketsReceived: this.totalPacketsReceived,
      totalBytesReceived: this.totalBytesReceived,
      channelStats,
    };
  }

  // Reset all stats
  reset(): void {
    this.queueWaitTimes = [];
    this.maxWaitTimeMs = 0;
    this.minWaitTimeMs = Infinity;
    this.packetSizes = [];
    this.maxPacketSize = 0;
    this.minPacketSize = Infinity;
    this.totalPacketsSent = 0;
    this.totalPacketsReceived = 0;
    this.totalBytesReceived = 0;
    this.channelMessageCounts.clear();
    this.packetMetadata.clear();
  }
}
