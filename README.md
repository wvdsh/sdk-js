# WavedashSDK-JS
The JS Wavedash SDK allows games developers to interact with the Wavedash Online Services

# Local Installation
This package is hosted on GitHub Packages. Follow these steps to install from GitHub Packages
1. Go to https://github.com/settings/tokens and create a Personal Access Token with read:packages permission
2. Copy it and add to your bash profile
```
export NODE_AUTH_TOKEN=yourtoken >> ~/.bashrc
```
3. Add the following to your `.npmrc` file in your project
```
@wvdsh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN} 
```

Now install the package:
```
npm install @wvdsh/js
```

# Usage
On the page that hosts the WASM game
```javascript
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
```javascript
createUnityInstance(canvas, config, (progress: number) => {
    loadingProgress = progress;
})
    .then((instance: UnityInstance) => {
        if ((window as any).WavedashJS) {
            (window as any).WavedashJS.setEngineInstance(instance);
        }
    })
```

