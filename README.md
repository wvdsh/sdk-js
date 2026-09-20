# Wavedash JavaScript SDK

The Wavedash JS SDK enables games to interact with Wavedash Online Services including leaderboards, multiplayer lobbies, P2P networking, cloud saves, achievements, and user-generated content.

## Read the Docs

https://docs.wavedash.com/

## Master volume

```ts
const applied = await Wavedash.requestVolume(0.35);
const volume = Wavedash.getVolume();

Wavedash.on(Wavedash.Events.VOLUME_CHANGED, ({ volume }) => {
  volumeSlider.value = String(volume);
});
```

`requestVolume(volume)` accepts a finite number from **0 to 1**, including decimals. Zero mutes; one is full volume. Values outside this range reject with a `RangeError`. The returned promise resolves to whether the host accepted the request. The host remains responsible for respecting an explicit player mute; the SDK applies volume only when the host broadcasts its accepted state.

`getVolume()` returns the effective master volume, or zero while muted. `VOLUME_CHANGED` carries `{ volume: number }` in the same 0–1 range. `isMuted()`, `toggleMute()`, and `MUTE_CHANGED` remain supported. Muting preserves the previous nonzero volume so a subsequent unmute restores it.

`requestMute(boolean)` is deprecated but remains functional for existing games and the Unity/Godot bindings. New integrations should use `requestVolume(0)` to mute and `requestVolume(desiredVolume)` to restore a chosen level.

The master volume multiplies a game's own audio levels. Web Audio uses a master gain with a short ramp. HTML audio/video uses the element's volume setting; media routed through a shimmed Web Audio context is scaled only at the master gain. HTML media volume remains subject to browser support, including iOS restrictions. Speech volume is sampled when an utterance is submitted; already-speaking utterances are not adjusted.

### Host integration

This SDK change requires a corresponding host update before the new request can work on Wavedash. Existing mute requests continue to use the existing protocol.

- Request: `{ type: "SetVolume", requestId, volume }`.
- Response: `{ requestId, requestType: "SetVolume", data: { success: boolean } }`.
- State broadcast: `{ type: "VolumeChanged", volume }`, including initial persisted volume when the game starts. Zero means muted. If also sending the legacy `MuteChanged` message, send `VolumeChanged` first so clients observe the final volume without an intermediate unmute level.

Without a host, `requestVolume` resolves to `false`. A host that does not implement `SetVolume` causes the existing iframe request timeout to reject; the SDK does not pretend the volume changed. These message types are defined locally in the SDK until the shared API package and host adopt the protocol.

## SDK call telemetry

The SDK sends `{ type: "SdkFunctionCalled", functionName, gameCloudId }` messages to its configured host, throttled to one message per function per second. The first call is sent immediately; additional calls within that second are suppressed. Continuous polling continues to emit at most once per second without waiting for a pause. Throttling is independent for each messenger, game, and public function. A single wrapper is installed around the SDK’s prototype methods when the module loads, so newly added public class methods are tracked automatically. It records the public method name before entering the method, including calls rejected by JSON parsing or initialization checks. No tracking calls are needed in individual methods or API helpers. Internal delegations through public methods are subject to the same throttling. Getters and inherited methods are not wrapped; internal methods are excluded by the central `untrackedMethods` set. New internal methods must be added to that set because TypeScript’s `private` modifier is erased at runtime.

No argument values, return values, tokens, messages, or save data are included. Event totals indicate function usage, not exact invocation counts. Only telemetry is throttled; SDK operations execute normally. Telemetry does not wait for a response, and transport errors do not interrupt SDK calls. Standalone sessions without a configured host do not send telemetry. Suppressed calls are not queued, so there are no trailing messages or timers to clean up.

The host follow-up must verify the iframe source/origin and forward each message to Amplitude as `sdk-function-called`, with `functionName` and the host's authoritative game/build context. Until that host change is deployed, these messages do not appear in Amplitude. The SDK does not embed an Amplitude key or send analytics directly to production.
