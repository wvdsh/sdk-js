# WavedashSDK-JS
The JS Wavedash SDK allows games developers to interact with the Wavedash Online Services

Track P2P networking statistics for debugging purposes. To enable stats tracking, add the `enableP2PStats` option to your init config:

```javascript
window.WavedashJS.init({
    gameId: "...",
    enableP2PStats: true  // Enable P2P stats tracking
});
```

Then you can access stats in the browser console:

```javascript
// Get current stats
window.WavedashJS.getP2PStats()

// Reset stats
window.WavedashJS.resetP2PStats()

// Enable/disable stats tracking at runtime
window.WavedashJS.enableP2PStats()
window.WavedashJS.disableP2PStats()
```

The stats object includes:
- **Queue wait times**: How long packets sit in the queue (avg, min, max)
- **Queue utilization**: Current queue size vs max capacity
- **Packet sizes**: Average, min, and max packet sizes
- **Counters**: Total packets sent/received, bytes received
- **Per-channel stats**: Queue status for each channel

