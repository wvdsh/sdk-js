import {
  IFRAME_MESSAGE_TYPE as SHARED_IFRAME_MESSAGE_TYPE,
  type IFrameEventPayloadMap as SharedIFrameEventPayloadMap
} from "@wvdsh/api";

export const IFRAME_MESSAGE_TYPE = {
  ...SHARED_IFRAME_MESSAGE_TYPE,
  SDK_FUNCTION_CALLED: "SdkFunctionCalled",
  SET_VOLUME: "SetVolume",
  VOLUME_CHANGED: "VolumeChanged"
} as const;

export type IFrameEventPayloadMap = SharedIFrameEventPayloadMap & {
  [IFRAME_MESSAGE_TYPE.SET_VOLUME]: { success: boolean };
  [IFRAME_MESSAGE_TYPE.VOLUME_CHANGED]: { volume: number };
};
