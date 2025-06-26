# WavedashSDK-JS
The JS Wavedash SDK allows games developers to interact with the Wavedash Online Services

# Local Installation
```
npm install @wvdsh/js
```

On the page that hosts the WASM game
```
import { setupWavedashSDK } from '@wvdsh/js';
import { useConvexClient } from 'convex-svelte';

const convexClient = useConvexClient();
const wavedashUser = {
    id: ...,  // fetched from backend
    username: ...  // fetched from backend
};
// Game session from the Wavedash backend that authorizes this user to play this game
const gameSessionToken = ...;  // fetched from backend

setupWavedashSDK(convexClient, gameSessionToken, wavedashUser);
```

WavedashJS is now set up, authenticated, and attached to the window.

If running a Unity game, we also need to give WavedashJS a reference to the Unity instance:
```
createUnityInstance(canvas, config, (progress: number) => {
    loadingProgress = progress;
})
    .then((instance: UnityInstance) => {
        if ((window as any).WavedashJS) {
            (window as any).WavedashJS.setEngineInstance(instance);
        }
    })
```

