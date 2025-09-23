// === Wavedash Lobby + P2P Console Test ===
// Copy and paste this entire file into your browser console
// Assumes window.WavedashJS is already initialized
// NOTE: P2P connections are now automatically managed by lobbies!

// Create a unique test user for this browser instance
const testUser = { 
    id: 'test-user-' + Math.random().toString(36).substr(2, 9), 
    username: 'TestUser' + Math.floor(Math.random() * 1000) 
};

console.log('🚀 Starting P2P test with user:', testUser);
console.log('📱 SDK found:', !!window.WavedashJS);

// === P2P Test Suite ===
window.p2pTest = {
    lobbyId: null,
    connection: null,
    
    // Step 1: Create and join lobby (run in Browser A first)
    async createLobby() {
        console.log('🏗️ Creating lobby...');
        try {
            const result = await window.WavedashJS.createLobby(0, 8);
            
            // Handle both browser mode (object) and engine mode (JSON string)
            this.lobbyId = result.success ? result.data : JSON.parse(result).data;
            
            console.log('✅ Lobby created:', this.lobbyId);
            console.log('🔗 P2P connections will be automatically established as users join!');
            console.log('📋 Copy this lobby ID for Browser B:', this.lobbyId);
            console.log('📋 Next: Browser B should run: p2pTest.joinLobby("' + this.lobbyId + '")');
            
            return this.lobbyId;
        } catch (error) {
            console.error('❌ Failed to create lobby:', error);
            throw error;
        }
    },
    
    // Step 2: Join existing lobby (run in Browser B)
    async joinLobby(lobbyId) {
        console.log('🚪 Joining lobby:', lobbyId);
        try {
            this.lobbyId = lobbyId;
            const result = await window.WavedashJS.joinLobby(lobbyId);
            
            const success = result.success !== undefined ? result.success : JSON.parse(result).success;
            
            if (success) {
                console.log('✅ Successfully joined lobby:', lobbyId);
                console.log('🔗 P2P connections will automatically establish when lobby subscription loads!');
                console.log('📋 You should be able to send messages immediately!');
                console.log('📋 Use: p2pTest.checkP2PReady() to verify status if needed');
            } else {
                console.error('❌ Failed to join lobby');
            }
            
            return result;
        } catch (error) {
            console.error('❌ Failed to join lobby:', error);
            throw error;
        }
    },
    
    // Step 3: Get lobby members (helper function)
    async getLobbyMembers() {
        if (!this.lobbyId) {
            console.error('❌ No lobby ID set. Create or join a lobby first.');
            return [];
        }
        
        console.log('👥 Getting lobby members...');
        try {
            // Use the SDK's internal convex client
            const response = await window.WavedashJS.getLobbyUsers(this.lobbyId);
            const members = JSON.parse(response).data || [];
            
            console.log('📋 Lobby members (' + members.length + '):', members.map(m => m.username || 'Unknown'));
            return members;
        } catch (error) {
            console.error('❌ Failed to get lobby members:', error);
            return [];
        }
    },
    
    // Step 3: Check P2P Ready Status (P2P is now automatically managed by lobbies)
    async checkP2PReady() {
        if (!this.lobbyId) {
            console.error('❌ No lobby ID set. Create or join a lobby first.');
            return;
        }
        
        console.log('🔍 Checking P2P connection status...');
        
        // Set up message callback to receive P2P messages if not already set
        if (!this._messageCallbackSet) {
            window.WavedashJS.setP2PMessageCallback((message) => {
                console.log('📨 P2P message received:', {
                    from: `Handle ${message.fromHandle}`,
                    to: message.toHandle ? `Handle ${message.toHandle}` : 'broadcast',
                    channel: message.channel,
                    data: message.data,
                    timestamp: new Date(message.timestamp).toLocaleTimeString()
                });
            });
            this._messageCallbackSet = true;
        }
        
        try {
            // Get current P2P connection info
            const connection = window.WavedashJS.getCurrentP2PConnection();
            
            if (connection) {
                this.connection = connection;
                console.log('✅ P2P connection found!');
                console.log('🎯 Your local handle:', connection.localHandle);
                console.log('🔢 Total peers:', Object.keys(connection.peers).length);
                
                // Show all peer handles for easy reference
                const peerList = Object.entries(connection.peers)
                    .map(([handle, peer]) => `${handle}: ${peer.username}`)
                    .join(', ');
                console.log('👥 Peer handles:', peerList);
                
                // Check channel readiness
                const statuses = window.WavedashJS.getPeerStatuses();
                const readyPeers = Object.values(statuses).filter(s => s.ready).length;
                const totalPeers = Object.keys(statuses).length;
                
                console.log(`📊 Ready channels: ${readyPeers}/${totalPeers}`);
                
                if (readyPeers === totalPeers && totalPeers > 0) {
                    console.log('✅ All P2P channels ready for messaging!');
                    console.log('📋 Try messaging: p2pTest.sendMessage(targetHandle, "Hello!")');
                    console.log('📋 Try broadcast: p2pTest.broadcast("Hello everyone!")');
                } else {
                    console.log('⏳ Some channels still connecting... Use p2pTest.waitForChannelsReady()');
                }
                
                return connection;
            } else {
                console.log('⚠️ No P2P connection found. This could mean:');
                console.log('  - Only 1 user in lobby (P2P requires 2+)');
                console.log('  - P2P still initializing');
                console.log('  - Connection failed');
                
                // Get current lobby members
                const members = await this.getLobbyMembers();
                if (members.length < 2) {
                    console.log(`💡 Current lobby has ${members.length} member(s). Need 2+ for P2P.`);
                } else {
                    console.log(`💡 Lobby has ${members.length} members. P2P should have initialized.`);
                }
                
                return null;
            }
        } catch (error) {
            console.error('❌ Failed to check P2P status:', error);
            throw error;
        }
    },
    
    // Step 5: Send P2P message to specific peer
    async sendMessage(toHandle, message = 'Hello from P2P!', reliable = true) {
        if (!this.connection) {
            console.error('❌ P2P not ready. Run p2pTest.checkP2PReady() first.');
            return;
        }
        
        // Check if peer is ready
        if (toHandle && !window.WavedashJS.isPeerReady(toHandle)) {
            console.warn(`⚠️ Peer ${toHandle} may not be ready. Checking status...`);
            this.checkPeerReady(toHandle);
            console.log('💡 Try p2pTest.waitForChannelsReady() or p2pTest.showChannelStatuses()');
        }
        
        console.log(`📤 Sending P2P message:`);
        console.log(`   To handle: ${toHandle}`);
        console.log(`   Reliable: ${reliable}`);
        console.log(`   Message: "${message}"`);
        
        try {
            const result = await window.WavedashJS.sendP2PMessage(toHandle, message, reliable);
            
            const success = result.success !== undefined ? result.success : JSON.parse(result).success;
            
            if (success) {
                console.log('✅ P2P message sent successfully!');
            } else {
                console.error('❌ P2P message failed to send');
            }
            
            return result;
        } catch (error) {
            console.error('❌ Failed to send P2P message:', error);
            throw error;
        }
    },
    
    // Step 6: Broadcast message to all peers
    async broadcast(message = 'Broadcast message from handle ' + (this.connection?.localHandle || '?'), reliable = true) {
        if (!this.connection) {
            console.error('❌ P2P not ready. Run p2pTest.checkP2PReady() first.');
            return;
        }
        
        console.log(`📡 Broadcasting P2P message:`);
        console.log(`   Reliable: ${reliable}`);
        console.log(`   Message: "${message}"`);
        
        try {
            const result = await window.WavedashJS.sendP2PMessage(undefined, message, reliable);
            
            const success = result.success !== undefined ? result.success : JSON.parse(result).success;
            
            if (success) {
                console.log('✅ Broadcast message sent successfully!');
            } else {
                console.error('❌ Broadcast message failed to send');
            }
            
            return result;
        } catch (error) {
            console.error('❌ Failed to broadcast message:', error);
            throw error;
        }
    },
    
    // Step 7: Send binary game data (simulates high-frequency updates)
    async sendGameData(toHandle) {
        if (!this.connection) {
            console.error('❌ P2P not ready. Run p2pTest.checkP2PReady() first.');
            return;
        }
        
        // Create mock binary data (like car position data)
        const mockCarData = new ArrayBuffer(32);
        const view = new DataView(mockCarData);
        view.setFloat32(0, Math.random() * 1000); // X position
        view.setFloat32(4, Math.random() * 1000); // Y position
        view.setFloat32(8, Math.random() * 360);  // Rotation
        view.setFloat32(12, Date.now());          // Timestamp
        
        console.log(`🎮 Sending binary game data:`);
        console.log(`   To handle: ${toHandle || 'all'}`);
        console.log(`   Size: ${mockCarData.byteLength} bytes`);
        console.log(`   Channel: unreliable (binary data)`);
        
        try {
            const result = await window.WavedashJS.sendGameData(toHandle, mockCarData);
            
            const success = result.success !== undefined ? result.success : JSON.parse(result).success;
            
            if (success) {
                console.log('✅ Game data sent successfully!');
            } else {
                console.error('❌ Game data failed to send');
            }
            
            return result;
        } catch (error) {
            console.error('❌ Failed to send game data:', error);
            throw error;
        }
    },
    
    // Helper: Show current test state
    status() {
        console.log('📊 P2P Test Status Report:');
        console.log('  🆔 Lobby ID:', this.lobbyId || '❌ None');
        console.log('  🔗 P2P Connection:', this.connection ? '✅ Enabled' : '❌ Disabled');
        
        if (this.connection) {
            console.log('  🎯 Local Handle:', this.connection.localHandle);
            console.log('  👥 Connected Peers:', Object.keys(this.connection.peers).length);
            console.log('  📊 Connection State:', this.connection.state);
            
            // List all peer handles for easy reference
            if (Object.keys(this.connection.peers).length > 0) {
                console.log('  🎮 Available Targets:');
                Object.entries(this.connection.peers).forEach(([handle, peer]) => {
                    console.log(`     Handle ${handle}: ${peer.username}`);
                });
            }
        }
    },
    
    // Helper: Get P2P connection info
    getConnectionInfo() {
        const connection = window.WavedashJS.getCurrentP2PConnection();
        if (connection) {
            console.log('🔗 Current P2P Connection:', connection);
            return connection;
        } else {
            console.log('❌ No active P2P connection');
            return null;
        }
    },
    
    // Helper: Disconnect P2P
    async disconnect() {
        console.log('🔌 Disconnecting P2P...');
        try {
            const result = await window.WavedashJS.disconnectP2P();
            console.log('✅ P2P disconnected:', result);
            this.connection = null;
            return result;
        } catch (error) {
            console.error('❌ Failed to disconnect P2P:', error);
            throw error;
        }
    },
    
    // Helper: Leave lobby
    async leaveLobby() {
        if (!this.lobbyId) {
            console.error('❌ No lobby to leave');
            return;
        }
        
        console.log('🚪 Leaving lobby...');
        try {
            const result = await window.WavedashJS.leaveLobby(this.lobbyId);
            console.log('✅ Left lobby:', result);
            
            // Clean up local state
            this.lobbyId = null;
            this.connection = null;
            
            return result;
        } catch (error) {
            console.error('❌ Failed to leave lobby:', error);
            throw error;
        }
    },
    
    // Helper: Enable/disable P2P message logging
    enableMessageLogging() {
        window.WavedashJS.setP2PMessageCallback((message) => {
            console.log('📨 P2P message received:', {
                from: `Handle ${message.fromHandle}`,
                to: message.toHandle ? `Handle ${message.toHandle}` : 'broadcast',
                channel: message.channel,
                data: message.data,
                timestamp: new Date(message.timestamp).toLocaleTimeString()
            });
        });
        console.log('✅ P2P message logging enabled');
    },
    
    disableMessageLogging() {
        window.WavedashJS.setP2PMessageCallback(null);
        console.log('🔇 P2P message logging disabled');
    },

    // Helper: Wait for WebRTC channels to be ready
    async waitForChannelsReady(timeout = 10000) {
        if (!this.connection) {
            console.error('❌ No P2P connection');
            return false;
        }

        const startTime = Date.now();
        const checkInterval = 500;
        
        while (Date.now() - startTime < timeout) {
            const statuses = window.WavedashJS.getPeerStatuses();
            const allReady = Object.values(statuses).every(status => status.ready);
            
            if (allReady) {
                console.log('✅ All WebRTC channels ready!');
                return true;
            }
            
            // Show progress
            const readyCount = Object.values(statuses).filter(status => status.ready).length;
            const totalCount = Object.keys(statuses).length;
            console.log(`⏳ Channels ready: ${readyCount}/${totalCount}`);
            
            await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
        
        console.warn('⚠️ Timeout waiting for channels. Some may not be ready.');
        this.showChannelStatuses();
        return false;
    },

    // Helper: Show channel statuses for debugging
    showChannelStatuses() {
        const statuses = window.WavedashJS.getPeerStatuses();
        console.log('📊 WebRTC Channel Statuses:');
        
        Object.entries(statuses).forEach(([handle, status]) => {
            const peer = this.connection?.peers[handle];
            const username = peer ? peer.username : 'Unknown';
            
            console.log(`  Handle ${handle} (${username}):`);
            if (status.reliable !== undefined) {
                console.log(`    Reliable: ${status.reliable}`);
            }
            if (status.unreliable !== undefined) {
                console.log(`    Unreliable: ${status.unreliable}`);
            }
            console.log(`    Ready: ${status.ready ? '✅' : '❌'}`);
        });
    },

    // Helper: Check if specific peer is ready
    checkPeerReady(handle) {
        const isReady = window.WavedashJS.isPeerReady(handle);
        const peer = this.connection?.peers[handle];
        const username = peer ? peer.username : 'Unknown';
        
        console.log(`🔍 Peer ${handle} (${username}) ready: ${isReady ? '✅' : '❌'}`);
        
        if (!isReady) {
            const statuses = window.WavedashJS.getPeerStatuses();
            const status = statuses[handle];
            if (status) {
                console.log(`  Reliable: ${status.reliable || 'N/A'}`);
                console.log(`  Unreliable: ${status.unreliable || 'N/A'}`);
            }
        }
        
        return isReady;
    },

    // Helper: Show available test functions
    help() {
        console.log(`
🔧 P2P Test Functions Available:

📋 Setup (do in order):
  p2pTest.createLobby()              - Create new lobby (Browser A first) 
  p2pTest.joinLobby('lobby-id')      - Join existing lobby (Browser B)
  p2pTest.checkP2PReady()            - Check P2P auto-connection status

💬 Messaging:
  p2pTest.sendMessage(handle, msg, reliable) - Send to specific peer  
  p2pTest.broadcast(msg, reliable)           - Send to all peers
  p2pTest.sendGameData(handle)               - Send binary data (unreliable)

ℹ️ Info & Control:
  p2pTest.status()                   - Show current state
  p2pTest.getLobbyMembers()          - List lobby members  
  p2pTest.getConnectionInfo()        - Show P2P connection details
  p2pTest.enableMessageLogging()     - Enable message receive logging
  p2pTest.disableMessageLogging()    - Disable message receive logging
  p2pTest.disconnect()               - Disconnect P2P
  p2pTest.leaveLobby()               - Leave current lobby
  p2pTest.help()                     - Show this help

🔧 Debugging:
  p2pTest.waitForChannelsReady()     - Wait for WebRTC channels to be ready
  p2pTest.showChannelStatuses()      - Show detailed channel status
  p2pTest.checkPeerReady(handle)     - Check if specific peer is ready

🧪 Quick Test Flow:
  Browser A: p2pTest.createLobby()
  Browser B: p2pTest.joinLobby('lobby-id-from-A')  
  Both: p2pTest.checkP2PReady()
  Both: p2pTest.sendMessage(targetHandle, 'Hello!', true)

📊 Check status anytime: p2pTest.status()
        `);
    },
    
    // Full test sequence for easy copy-paste
    async runFullTest() {
        console.log('🧪 Running full P2P test sequence...');
        console.log('⚠️  This assumes you are Browser A (creating lobby)');
        console.log('⚠️  Browser B should run p2pTest.joinLobby() with the lobby ID');
        
        try {
            // Step 1: Create lobby
            await this.createLobby();
            
            console.log('⏳ Waiting 3 seconds for Browser B to join...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Step 2: Enable P2P
            await this.enableP2P();
            
            // Step 3: Send test messages
            if (this.connection && Object.keys(this.connection.peers).length > 1) {
                await this.broadcast('Hello from the test sequence!');
                
                // Send to first other peer
                const otherPeers = Object.keys(this.connection.peers)
                    .map(h => Number(h))
                    .filter(h => h !== this.connection.localHandle);
                
                if (otherPeers.length > 0) {
                    await this.sendMessage(otherPeers[0], 'Direct message test!');
                    await this.sendGameData(otherPeers[0]);
                }
            }
            
            console.log('✅ Full test sequence completed!');
            this.status();
            
        } catch (error) {
            console.error('❌ Test sequence failed:', error);
        }
    }
};

// Auto-show help and status
console.log('🎮 P2P Test Suite Loaded!');
p2pTest.help();
console.log('🚀 Ready to test! P2P is now automatic with lobbies!');