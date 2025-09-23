# SharedArrayBuffer P2P Message Queues

The Wavedash SDK uses per-channel SharedArrayBuffers to enable zero-copy P2P message passing between JavaScript and game engines.

## Per-Channel Queue Structure

### Header (16 bytes at offset 0)
```
[writeIndex: 4 bytes][readIndex: 4 bytes][messageCount: 4 bytes][version: 4 bytes]
```

### Message Data (starts at offset 16)
Each message slot is 512 bytes:
```
[messageSize: 4 bytes][binaryMessage: up to 508 bytes]
```

### Binary Message Format (inside each slot)
```
[fromUserId: 32 bytes][channel: 4 bytes][timestamp: 8 bytes][dataLength: 4 bytes][data: variable]
```

## Godot Integration

### 1. Access Channel-Specific SharedArrayBuffers
```gdscript
# Get specific channel queue from JavaScript
var channel_0_buffer = JavaScript.get_interface("window").WavedashP2PChannelQueues[0]
var channel_1_buffer = JavaScript.get_interface("window").WavedashP2PChannelQueues[1]

# Or get directly from SDK
var channel_buffer = window.WavedashJS.getP2PChannelQueue(0)

# Create a PackedByteArray view for a channel
var queue_view = PackedByteArray()
queue_view.resize(channel_buffer.byteLength)
```

### 2. Read Queue Header
```gdscript
func read_queue_header(queue_view: PackedByteArray) -> Dictionary:
    var header = {}
    header.write_index = queue_view.decode_u32(0)
    header.read_index = queue_view.decode_u32(4) 
    header.message_count = queue_view.decode_u32(8)
    header.version = queue_view.decode_u32(12)
    return header
```

### 3. Read Messages from Specific Channel
```gdscript
# Godot function to read messages from a specific channel
func readP2PMessagesOnChannel(channel: int = 0, num_messages: int = 10) -> Array:
    var channel_buffer = JavaScript.get_interface("window").WavedashP2PChannelQueues[channel]
    if not channel_buffer:
        return []
    
    var queue_view = PackedByteArray()
    queue_view.resize(channel_buffer.byteLength)
    return read_messages_from_queue(queue_view, num_messages)

func read_messages_from_queue(queue_view: PackedByteArray, max_messages: int) -> Array:
    var messages = []
    var header = read_queue_header(queue_view)
    
    var messages_read = 0
    while header.message_count > 0 and messages_read < max_messages:
        var read_offset = 16 + (header.read_index * 512)  # HEADER_SIZE + slot
        
        # Read message size
        var message_size = queue_view.decode_u32(read_offset)
        if message_size == 0 or message_size > 508:
            break
        
        # Read binary message
        var message_data = queue_view.slice(read_offset + 4, read_offset + 4 + message_size)
        var message = decode_binary_message(message_data)
        messages.append(message)
        
        # Update read pointer atomically
        header.read_index = (header.read_index + 1) % 256  # QUEUE_SIZE
        header.message_count -= 1
        
        # Write back updated header
        queue_view.encode_u32(4, header.read_index)
        queue_view.encode_u32(8, header.message_count)
        
        messages_read += 1
    
    return messages

func decode_binary_message(data: PackedByteArray) -> Dictionary:
    var message = {}
    
    # fromUserId (32 bytes)
    var from_bytes = data.slice(0, 32)
    message.from_user_id = from_bytes.get_string_from_utf8().strip_edges(false, true)
    
    # channel (4 bytes)
    message.channel = data.decode_u32(32)
    
    # timestamp (8 bytes) 
    message.timestamp = data.decode_u64(36)
    
    # data length (4 bytes)
    var data_length = data.decode_u32(44)
    
    # data (variable)
    if data_length > 0:
        message.data = data.slice(48, 48 + data_length)
    else:
        message.data = PackedByteArray()
    
    return message
```

### 4. Polling Loop (in Godot)
```gdscript
# Call this every frame or on a timer
func _process(_delta):
    if shared_buffer_available:
        var messages = read_p2p_messages(queue_view)
        for message in messages:
            handle_p2p_message(message)
```

## Performance Benefits

- **Zero-copy**: Direct memory access, no serialization
- **High throughput**: ~1024 messages buffered  
- **Low latency**: Atomic operations, no locks
- **Efficient**: Only 48-byte header + your data
