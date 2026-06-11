// Classic-script (IIFE) build of the runtime, for environments that inject
// the SDK into game HTML as a parser-blocking <script> tag — `wavedash dev`'s
// local server does this, mirroring how play injects embed.js in prod — so
// `window.Wavedash` exists before any game script parses.
//
// Auto-runs setup: the page URL must carry `?sdkconfig=`.
import { setupWavedashSDK } from "./index";

setupWavedashSDK();
