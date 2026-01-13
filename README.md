# Wavedash JavaScript SDK

The Wavedash JS SDK enables games to interact with Wavedash Online Services including leaderboards, multiplayer lobbies, P2P networking, cloud saves, achievements, and user-generated content.

## Initialization

The SDK is automatically available to games hosted on wavedash.com. Initialize it in your game's entry point:

```javascript
const sdk = await setupWavedashSDK();

sdk.init({
  debug: false,              // Enable debug logging
  deferEvents: false,        // If true, call readyForEvents() when the game is ready to receive signals
});
```

### Game Engine Integration

For Unity/Godot games, attach the engine instance BEFORE initialization. Game engines can access the SDK globally via `window.WavedashJS`:

```javascript
window.WavedashJS.setEngineInstance(engineInstance);
window.WavedashJS.init({
  debug: false
})
```

## Types

The SDK exports TypeScript types for all API parameters. See `src/types.ts` for full definitions:

```typescript
import type {
  LobbyVisibility,
  LeaderboardSortOrder,
  LeaderboardDisplayType,
  UGCType,
  UGCVisibility,
  Leaderboard,
  LeaderboardEntries,
  Lobby,
  LobbyUser,
  LobbyMessage,
  P2PMessage,
  WavedashResponse,
  Id,
} from "@wvdsh/js";
```

## API Reference

### User

```typescript
sdk.getUser()              // Returns the current user object
sdk.getUserId()            // Returns the current user's ID
sdk.getUsername()          // Returns the current user's username
```

### Leaderboards

```typescript
// Get or create a leaderboard
const leaderboard = await sdk.getOrCreateLeaderboard(
  "high_scores",           // name: string
  sortOrder,               // sortOrder: LeaderboardSortOrder
  displayType              // displayType: LeaderboardDisplayType
);

// Get existing leaderboard
const leaderboard = await sdk.getLeaderboard("high_scores");

// Submit a score
await sdk.uploadLeaderboardScore(
  leaderboardId,
  1000,                    // score
  true,                    // keepBest: only update if better than existing
  ugcId                    // optional: attach UGC (replay, ghost, etc.)
);

// Query entries
await sdk.listLeaderboardEntries(leaderboardId, 0, 10);           // offset, limit
await sdk.listLeaderboardEntriesAroundUser(leaderboardId, 5, 5);  // countAhead, countBehind
await sdk.getMyLeaderboardEntries(leaderboardId);
sdk.getLeaderboardEntryCount(leaderboardId);                       // sync, from cache
```

### Multiplayer Lobbies

```typescript
// Create and join a lobby
const result = await sdk.createLobby(
  visibility,              // visibility: LobbyVisibility
  maxPlayers               // maxPlayers: number (optional)
);

// Join existing lobby
await sdk.joinLobby(lobbyId);             // lobbyId: Id<"lobbies">

// List and query lobbies
await sdk.listAvailableLobbies(false);    // friendsOnly: boolean
sdk.getLobbyUsers(lobbyId);
sdk.getNumLobbyUsers(lobbyId);
sdk.getLobbyHostId(lobbyId);

// Lobby data (key-value storage synced to all members)
sdk.setLobbyData(lobbyId, "gameMode", "deathmatch");
sdk.getLobbyData(lobbyId, "gameMode");

// Messaging and leaving
sdk.sendLobbyMessage(lobbyId, "Hello!");
await sdk.leaveLobby(lobbyId);
```

### P2P Networking

P2P connections are automatically established when users join a lobby.

```typescript
// Check connection status
sdk.isPeerReady(userId);
sdk.isBroadcastReady();    // true if at least one peer is connected

// Send messages
sdk.sendP2PMessage(
  userId,              // target user (undefined for broadcast)
  0,                   // appChannel for routing (use 0 if your game doesn't need separate message channels)
  true,                // reliable (ordered, guaranteed delivery) or unreliable (unordered but faster)
  payload              // Uint8Array
);

sdk.broadcastP2PMessage(0, true, payload);

// Receive messages
const msg = sdk.readP2PMessageFromChannel(0);  // Returns P2PMessage or null
// msg.fromUserId, msg.channel, msg.payload

// For game engines: drain all messages into a buffer
const buffer = sdk.drainP2PChannelToBuffer(0, preallocatedBuffer);
```

### Cloud Saves / Remote File Storage

```typescript
// Upload and download files (uses IndexedDB locally)
await sdk.uploadRemoteFile("/saves/slot1.dat");
await sdk.downloadRemoteFile("/saves/slot1.dat");
await sdk.downloadRemoteDirectory("/saves");
await sdk.listRemoteDirectory("/saves");

// Local file I/O for pure JS games
await sdk.writeLocalFile("/saves/slot1.dat", uint8Array);
const data = await sdk.readLocalFile("/saves/slot1.dat");
```

### Achievements & Stats

```typescript
// Request stats from server (call once at game start)
await sdk.requestStats();

// Read values
sdk.getAchievement("first_win");  // boolean
sdk.getStat("total_kills");       // number

// Write values
sdk.setAchievement("first_win");
sdk.setStat("total_kills", 100);

// Persist to server
sdk.storeStats();
```

### User-Generated Content (UGC)

```typescript
// Create UGC item
const result = await sdk.createUGCItem(
  ugcType,                 // ugcType: UGCType
  "My Best Run",           // title: string (optional)
  "Description",           // description: string (optional)
  visibility,              // visibility: UGCVisibility (optional)
  "/replays/run1.dat"      // filePath: string (optional) - IndexedDB path to upload
);

// Update and download
await sdk.updateUGCItem(ugcId, title, description, visibility, filePath);
await sdk.downloadUGCItem(ugcId, "/replays/downloaded.dat");
```

### User Presence

```typescript
// Update rich presence for friends to see
await sdk.updateUserPresence({ status: "In Match", level: 5 });
```

### Utility

```typescript
sdk.isReady();                      // Check if SDK is initialized
sdk.readyForEvents();               // Signal ready for events (if deferEvents was true)
sdk.toggleOverlay();                // Toggle the Wavedash overlay
sdk.loadComplete();                 // Signal that game has finished loading
sdk.updateLoadProgressZeroToOne(0.5);  // Update loading progress (0-1)
```

## Signals (Events)

For game engines, the SDK sends signals via `SendMessage` to `WavedashCallbackReceiver`. JS games can access these through callbacks or polling.

| Signal | Description |
|--------|-------------|
| `LobbyJoined` | Successfully joined a lobby |
| `LobbyMessage` | Received a lobby chat message |
| `LobbyUsersUpdated` | Lobby membership changed |
| `LobbyDataUpdated` | Lobby key-value data changed |
| `LobbyKicked` | Removed from lobby |
| `P2PConnectionEstablished` | P2P connection to peer is ready |
| `P2PConnectionFailed` | P2P connection to peer failed |
| `P2PPeerDisconnected` | Peer disconnected |
| `BackendConnected` | Connected to backend |
| `BackendDisconnected` | Disconnected from backend |
| `BackendReconnecting` | Attempting to reconnect |

## Response Format

Most async methods return a `WavedashResponse<T>`:

```typescript
{
  success: boolean;
  data: T | null;
  message?: string;  // Error message if success is false
}
```
