import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { type WavedashSDK } from "../index";
import { WavedashManager } from "./manager";
import { WavedashEvents } from "../events";
import type { MuteChangedPayload } from "../types";

/**
 * Set of WeakRefs — lets us iterate tracked elements without preventing GC.
 * Stale entries are purged lazily during iteration.
 */
class WeakRefSet<T extends object> {
  private set = new Set<WeakRef<T>>();

  add(value: T): void {
    for (const ref of this.set) {
      if (ref.deref() === value) return;
    }
    this.set.add(new WeakRef(value));
  }

  forEach(callback: (value: T) => void): void {
    for (const ref of this.set) {
      const v = ref.deref();
      if (v === undefined) this.set.delete(ref);
      else callback(v);
    }
  }

  clear(): void {
    this.set.clear();
  }
}

/**
 * AudioManager
 *
 * Mutes & unmutes the game in response to MUTE_CHANGED iframe messages, without
 * the game needing to know anything about it.
 *
 * Web Audio: subclass `AudioContext` so `ctx.destination` resolves to a master
 * GainNode that we control. The master gain wires to the real native destination,
 * so `node.connect(ctx.destination)` and any other game code is unaffected.
 *
 * HTML Media (`<audio>`/`<video>`): override `HTMLMediaElement.prototype.muted`
 * to record the game's intended state, but write `true` to the underlying element
 * whenever the SDK is muted. Tracked elements come from three sources:
 *  1. Pre-existing DOM media (`querySelectorAll`)
 *  2. `new Audio()` constructor shim (covers detached SFX)
 *  3. MutationObserver for any media added to the DOM later (covers innerHTML,
 *     framework rendering, createElement + append, etc.)
 */
export class AudioManager extends WavedashManager {
  private _isMuted = false;

  // Web Audio contexts and their master gain nodes
  private contexts = new Map<AudioContext, GainNode>();

  // HTML media elements we know about + their game-intended muted state
  private elements = new WeakRefSet<HTMLMediaElement>();
  private intendedMuted = new WeakMap<HTMLMediaElement, boolean>();

  // Originals (restored on destroy)
  private originalAudioContext: typeof AudioContext | null = null;
  private originalWebKitAudioContext: typeof AudioContext | null = null;
  private originalAudio: typeof Audio | null = null;
  private originalMutedDescriptor: PropertyDescriptor | null = null;
  private mutationObserver: MutationObserver | null = null;

  constructor(sdk: WavedashSDK) {
    super(sdk);
    this.installShims();
    this.sdk.iframeMessenger.addEventListener(
      IFRAME_MESSAGE_TYPE.MUTE_CHANGED,
      this.handleMute
    );
  }

  isMuted(): boolean {
    return this._isMuted;
  }

  /**
   * Ask the host to mute (true) or unmute (false). Resolves to `true` if the
   * host applied the change, `false` otherwise — notably, the host rejects an
   * unmute when the user muted the game from the Wavedash UI, so games can't
   * override an explicit user mute. The resulting state arrives via the usual
   * MUTE_CHANGED broadcast, so `isMuted()` updates independently of this result.
   */
  async requestMute(muted: boolean): Promise<boolean> {
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.SET_MUTE,
      { muted }
    );
    return response.success;
  }

  /**
   * Toggle mute. Like `requestMute`, the host may reject the unmute half of a
   * toggle if the user muted from the Wavedash UI. Resolves to `true` if the
   * host applied the change.
   */
  async toggleMute(): Promise<boolean> {
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.TOGGLE_MUTE
    );
    return response.success;
  }

  private handleMute = (data: { isMuted: boolean }): void => {
    if (this._isMuted === data.isMuted) return;
    this._isMuted = data.isMuted;

    // Web Audio: short ramp avoids audible pops on instant 0↔1 jumps.
    // cancelScheduledValues clears any in-flight ramp from a recent toggle so
    // we don't follow a stale target before reaching the new one.
    const target = this._isMuted ? 0 : 1;
    this.contexts.forEach((gain, ctx) => {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + 0.05);
    });

    // HTML Media: force native muted=true while muted, restore intent on unmute
    const setMutedNative = this.originalMutedDescriptor?.set;
    if (setMutedNative) {
      this.elements.forEach((el) => {
        const intended = this.intendedMuted.get(el) ?? false;
        setMutedNative.call(el, this._isMuted ? true : intended);
      });
    }

    // Notify game in case it needs to update in-game UI
    this.sdk.gameEventManager.notifyGame(
      WavedashEvents.MUTE_CHANGED,
      { isMuted: this._isMuted } satisfies MuteChangedPayload
    );
  };

  /**
   * Track a media element and (if SDK is currently muted) silence it.
   * Idempotent — safe to call multiple times for the same element.
   */
  private trackElement(el: HTMLMediaElement): void {
    if (this.intendedMuted.has(el)) return;
    const getMuted = this.originalMutedDescriptor?.get;
    const setMuted = this.originalMutedDescriptor?.set;
    const current = getMuted ? getMuted.call(el) : el.muted;
    this.intendedMuted.set(el, current);
    this.elements.add(el);
    if (this._isMuted && !current && setMuted) {
      setMuted.call(el, true);
    }
  }

  private installShims(): void {
    if (typeof window === "undefined") return;

    // 1. AudioContext (+ webkit prefix): subclass to redirect destination
    if (window.AudioContext) {
      this.originalAudioContext = window.AudioContext;
      window.AudioContext = this.shimAudioContextClass(window.AudioContext);
    }
    const win = window as unknown as Window & {
      webkitAudioContext?: typeof AudioContext;
    };
    if (win.webkitAudioContext) {
      this.originalWebKitAudioContext = win.webkitAudioContext;
      win.webkitAudioContext = this.shimAudioContextClass(win.webkitAudioContext);
    }

    // 2. `new Audio()` — common pattern for detached one-shot SFX that never
    //    enters the DOM (so the MutationObserver below wouldn't catch it).
    if (window.Audio) {
      const OriginalAudio = window.Audio;
      this.originalAudio = OriginalAudio;
      ((manager) => {
        const Shimmed = function (src?: string) {
          const audio = new OriginalAudio(src);
          manager.trackElement(audio);
          return audio;
        };
        Shimmed.prototype = OriginalAudio.prototype;
        window.Audio = Shimmed as unknown as typeof Audio;
      })(this);
    }

    if (typeof document !== "undefined") {
      // 3a. Pre-existing DOM media at SDK init.
      document.querySelectorAll("audio, video").forEach((el) => {
        this.trackElement(el as HTMLMediaElement);
      });

      // 3b. MutationObserver picks up anything added to the DOM later —
      //     covers innerHTML, framework rendering, createElement + append, etc.
      this.mutationObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            if (node instanceof HTMLMediaElement) {
              this.trackElement(node);
            } else if (node instanceof HTMLElement) {
              node.querySelectorAll("audio, video").forEach((el) => {
                this.trackElement(el as HTMLMediaElement);
              });
            }
          });
        }
      });
      this.mutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // 4. Override HTMLMediaElement.prototype.muted so the game sees its own
    //    intended value while we silently force the underlying element to true.
    this.originalMutedDescriptor =
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted") ??
      null;
    const original = this.originalMutedDescriptor;
    if (original?.get && original?.set) {
      ((manager) => {
        Object.defineProperty(HTMLMediaElement.prototype, "muted", {
          configurable: true,
          get(this: HTMLMediaElement): boolean {
            const intended = manager.intendedMuted.get(this);
            return intended !== undefined ? intended : original.get!.call(this);
          },
          set(this: HTMLMediaElement, value: boolean) {
            manager.intendedMuted.set(this, value);
            manager.elements.add(this);
            original.set!.call(this, manager._isMuted ? true : value);
          }
        });
      })(this);
    }
  }

  private shimAudioContextClass(
    Original: typeof AudioContext
  ): typeof AudioContext {
    return ((manager) =>
      class extends Original {
        constructor(opts?: AudioContextOptions) {
          super(opts);
          const masterGain = this.createGain();
          masterGain.connect(this.destination);
          masterGain.gain.setValueAtTime(
            manager._isMuted ? 0 : 1,
            this.currentTime
          );
          // Redirect ctx.destination → masterGain. Game code calling
          // `node.connect(ctx.destination)` keeps working transparently.
          Object.defineProperty(this, "destination", {
            configurable: true,
            get() {
              return masterGain;
            }
          });
          manager.contexts.set(this, masterGain);
        }

        close(): Promise<void> {
          manager.contexts.delete(this);
          return super.close();
        }
      })(this);
  }

  override destroy(): void {
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.MUTE_CHANGED,
      this.handleMute
    );

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

    if (typeof window !== "undefined") {
      if (this.originalAudioContext) {
        window.AudioContext = this.originalAudioContext;
      }
      const win = window as unknown as Window & {
        webkitAudioContext?: typeof AudioContext;
      };
      if (this.originalWebKitAudioContext && win.webkitAudioContext) {
        win.webkitAudioContext = this.originalWebKitAudioContext;
      }
      if (this.originalAudio) {
        window.Audio = this.originalAudio;
      }
    }

    if (this.originalMutedDescriptor) {
      Object.defineProperty(
        HTMLMediaElement.prototype,
        "muted",
        this.originalMutedDescriptor
      );
    }

    this.contexts.clear();
    this.elements.clear();
    this.intendedMuted = new WeakMap();

    super.destroy();
  }
}
