import type { WavedashSDK } from "./index";

declare global {
  interface Window {
    Wavedash: WavedashSDK;
  }
}

const Wavedash = window.Wavedash;
if (!Wavedash) {
  throw new Error(
    "Wavedash is not initialized. If you're running your game locally use the `wavedash dev` command to ensure the Wavedash SDK is loaded."
  );
}

export default Wavedash;

export type * from "./types";
export type { WavedashSDK };
