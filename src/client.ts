import type { WavedashSDK } from "./index";

declare global {
  interface Window {
    Wavedash: WavedashSDK;
    WavedashJS: WavedashSDK;
  }
}

const sdk = window.Wavedash;
if (!sdk) {
  throw new Error(
    "Wavedash is not initialized. If you're running your game locally use the `wavedash dev` command to ensure the Wavedash SDK is loaded."
  );
}

export default sdk;

export type * from "./types";
export type { Wavedash } from "./index";
