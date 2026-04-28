/** Reasons why a user was kicked from a lobby */
export const LobbyKickedReason = {
  KICKED: "KICKED",
  ERROR: "ERROR"
} as const;

/** Change types for lobby user updates */
export const LobbyUserChangeType = {
  JOINED: "JOINED",
  LEFT: "LEFT"
} as const;

/**
 * Reason a P2P packet was dropped. Each reason implies a different
 * game-side remedy:
 * - QUEUE_FULL: throttle your sends, bundle updates into fewer packets, or increase p2p maxIncomingMessages config
 * - PAYLOAD_TOO_LARGE: reduce payload or increase p2p messageSize config
 * - INVALID_PAYLOAD_SIZE: programming error
 * - INVALID_CHANNEL: SDK version skew or malicious peer
 * - MALFORMED: wire data too short to parse; channel will be -1
 * - PEER_NOT_READY: P2P not yet initialized, or peer was never ready / closed mid-send. If P2P hasn't been initialized, initialize it first; otherwise wait for P2P_CONNECTION_ESTABLISHED and watch P2P_PEER_DISCONNECTED/P2P_CONNECTION_FAILED/P2P_PEER_RECONNECTING for reachability.
 */
export const P2PPacketDropReason = {
  QUEUE_FULL: "QUEUE_FULL",
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  INVALID_PAYLOAD_SIZE: "INVALID_PAYLOAD_SIZE",
  INVALID_CHANNEL: "INVALID_CHANNEL",
  MALFORMED: "MALFORMED",
  PEER_NOT_READY: "PEER_NOT_READY"
} as const;

/**
 * Avatar size presets in pixels. Pass any of these (or a custom pixel size)
 * to `Wavedash.getUserAvatarUrl(userId, size)`.
 */
export const AvatarSize = {
  SMALL: 64, // Lists, chat bubbles
  MEDIUM: 128, // Profile cards
  LARGE: 256 // Large displays
} as const;
