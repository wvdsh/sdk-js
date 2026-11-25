import { api, IFRAME_MESSAGE_TYPE, SDK_FEATURE } from "@wvdsh/api";
import { WavedashEvents } from "../events";
import type { WavedashSDK } from "../index";

type SdkFeature = (typeof SDK_FEATURE)[keyof typeof SDK_FEATURE];

// Calling any of these records the feature against the game on the backend,
// which feeds the game's content rating. The P2P limit and buffer getters are
// left out because engine SDKs call them during init whether or not the game
// uses P2P, and event listeners are left out because engine SDKs register
// every event up front.
const FEATURE_BY_FUNCTION: Partial<Record<keyof WavedashSDK, SdkFeature>> = {
  createLobby: SDK_FEATURE.LOBBY,
  joinLobby: SDK_FEATURE.LOBBY,
  listAvailableLobbies: SDK_FEATURE.LOBBY,
  getLobby: SDK_FEATURE.LOBBY,
  getLobbyUsers: SDK_FEATURE.LOBBY,
  getNumLobbyUsers: SDK_FEATURE.LOBBY,
  getLobbyHostId: SDK_FEATURE.LOBBY,
  getLobbyData: SDK_FEATURE.LOBBY,
  setLobbyData: SDK_FEATURE.LOBBY,
  deleteLobbyData: SDK_FEATURE.LOBBY,
  leaveLobby: SDK_FEATURE.LOBBY,
  sendLobbyMessage: SDK_FEATURE.LOBBY,
  inviteUserToLobby: SDK_FEATURE.LOBBY,
  getLobbyInviteLink: SDK_FEATURE.LOBBY,
  sendP2PMessage: SDK_FEATURE.P2P,
  broadcastP2PMessage: SDK_FEATURE.P2P,
  readP2PMessageFromChannel: SDK_FEATURE.P2P,
  drainP2PChannelToBuffer: SDK_FEATURE.P2P,
  createUGCItem: SDK_FEATURE.UGC,
  updateUGCItem: SDK_FEATURE.UGC,
  deleteUGCItem: SDK_FEATURE.UGC,
  downloadUGCItem: SDK_FEATURE.UGC,
  listUGCItems: SDK_FEATURE.UGC
};

const wavedashEventNames = new Set<string>(Object.values(WavedashEvents));
const reportedEvents = new Set<string>();
const recordedFeatures = new Set<SdkFeature>();

export function trackSdkEventListener(
  sdk: WavedashSDK,
  eventName: string
): void {
  if (!wavedashEventNames.has(eventName) || reportedEvents.has(eventName)) {
    return;
  }
  reportedEvents.add(eventName);
  trackSdkCall(sdk, `on${eventName}`);
}

function trackSdkCall(sdk: WavedashSDK, functionName: string): void {
  try {
    sdk.iframeMessenger.postToParent(IFRAME_MESSAGE_TYPE.SDK_FUNCTION_CALLED, {
      functionName
    });
  } catch {
    // Analytics only, never break the game's call
  }
  const feature = FEATURE_BY_FUNCTION[functionName as keyof WavedashSDK];
  if (feature) recordFeatureUsage(sdk, feature);
}

// Once per feature per session. A failed send clears the entry so the next
// tracked function in that feature tries again.
function recordFeatureUsage(sdk: WavedashSDK, feature: SdkFeature): void {
  if (recordedFeatures.has(feature)) return;
  recordedFeatures.add(feature);
  sdk.convexClient
    .mutation(api.sdk.featureUsage.recordFeatureUsage, { feature })
    .catch(() => recordedFeatures.delete(feature));
}

export function createTrackedSdk(sdk: WavedashSDK): WavedashSDK {
  const prototype = Object.getPrototypeOf(sdk) as object;

  for (const [name, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(prototype)
  )) {
    if (name === "constructor" || name.startsWith("_")) continue;
    if (typeof descriptor.value !== "function") continue;

    const original = (
      descriptor.value as (this: WavedashSDK, ...args: unknown[]) => unknown
    ).bind(sdk);

    const install = (value: unknown) => {
      Object.defineProperty(sdk, name, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: true,
        value
      });
    };

    // Tracks the first call, not the first read, so feature detection,
    // destructuring, or glue code that binds methods up front doesn't count as
    // the game using a function. The first call swaps in the original so later
    // calls skip this wrapper and its ...args copy.
    let called = false;
    const trackFirstCall = (...args: unknown[]) => {
      if (!called) {
        called = true;
        install(original);
        trackSdkCall(sdk, name);
      }
      return original(...args);
    };

    Object.defineProperty(sdk, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => trackFirstCall,
      set: install
    });
  }

  return sdk;
}
