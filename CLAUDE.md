# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

The Wavedash JavaScript SDK (`@wvdsh/js`) is a TypeScript SDK that enables game developers to interact with Wavedash Online Services. The SDK supports both web browsers and game engines (Unity, Godot) through a unified API.

## Key Commands

```bash
# Build the SDK for production
npm run build

# Build browser bundle (IIFE format with global WavedashSDK)
npm run build:browser

# Development mode with file watching
npm run dev

# Install dependencies
npm install
```

## Architecture

### Core Components

- **`src/index.ts`**: Main SDK class (`WavedashSDK`) and setup function (`setupWavedashSDK`)
- **`src/types.ts`**: TypeScript type definitions and interfaces
- **`src/convex_api.ts`**: Auto-generated API types from Convex backend
- **`src/constants.ts`**: SDK constants and configuration values

### SDK Architecture

The SDK follows a class-based architecture with dual-mode operation:

1. **Browser Mode**: Returns native JavaScript objects for web applications
2. **Game Engine Mode**: Returns JSON strings for Unity/Godot integration

#### Key Patterns

- **Context-Aware Responses**: `formatResponse()` method automatically formats return values based on whether a game engine instance is attached
- **Async Operation Handling**: Centralized error handling through helper methods
- **Type Safety**: Extensive use of TypeScript with API types extracted from Convex backend
- **Caching**: Leaderboard caching using `Map<Id<"leaderboards">, Leaderboard>`

### API Integration

The SDK integrates with a Convex backend through:
- **Queries**: Read operations (getting leaderboards, user data, etc.)
- **Mutations**: Write operations (creating lobbies, sending messages, etc.)
- **Subscriptions**: Real-time updates (lobby messages)

## Key Features

### Leaderboards
- Get/create leaderboards with different sort methods and display types
- Submit scores with metadata and UGC attachments
- Query leaderboard entries and rankings

### Game Lobbies
- Create and join multiplayer lobbies
- Real-time messaging within lobbies
- Automatic subscription management for lobby updates

### User-Generated Content (UGC)
- Upload and manage user-created content
- Attach UGC to leaderboard entries
- Control visibility and access permissions

### P2P Networking
- WebRTC-based peer-to-peer connections between lobby members
- Convex backend handles initial WebRTC signaling (offer/answer/ICE exchange)
- Integer peer handles for performance-optimized messaging
- Reliable and unreliable data channels for different message types
- Deterministic peer handle assignment based on sorted user IDs
- TURN server fallback for NAT traversal when direct connections fail
- API: `enableP2P()`, `sendP2PMessage(toHandle, data, reliable)`, `sendGameData(toHandle, data)`

Next steps:
1. Lobby host + members + chat should all be handled via Convex in lobby.ts
2. Autocreate P2P connections between all lobby members when lobby changes
3. Use SharedArrayBuffer to queue up received P2P messages
4. One SharedArrayBuffer for each channel so game can process them at different rates
5. All channel comms still use the same P2P connection under the hood
6. API surface can then simply be:
* sendMessage(toUser, channel, data, reliable)
* readMessagesOnChannel(channel, numMessages)

Later:
1. Timeout connections that are unused for long enough, the next sendMessage would trigger a new connection to be made
2. Allow different P2P network topology (mesh, star, relay)
3. Don't auto-connect every single lobby member, generate P2P connection on the fly when game first tries to send a packet to a user
4. More customization on sending (no delay, buffering)

### Dual Platform Support
- **Web**: Direct JavaScript object returns
- **Game Engines**: JSON string communication via `SendMessage` interface

## Build System

- **tsup**: Modern TypeScript bundler with multiple output formats
- **Outputs**: ESM (.mjs), CommonJS (.js), and TypeScript declarations (.d.ts)
- **External Dependencies**: Convex is marked as external (peer dependency)
- **Browser Bundle**: Separate IIFE build for direct browser usage

## Installation & Distribution

The package is distributed via GitHub Packages Registry and requires authentication:
- Published to `@wvdsh:registry=https://npm.pkg.github.com`
- Requires `NODE_AUTH_TOKEN` environment variable for installation
- Version managed in `package.json` (currently 0.0.4)

## Development Notes

- No test framework is configured
- No linting tools are present in the current setup
- Uses TypeScript strict mode with ES2020 target
- The SDK expects a Convex client to be provided during initialization