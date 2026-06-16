import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashEvents } from "../events";
import { type WavedashSDK } from "../index";
import type { MuteChangedPayload } from "../types";
import { WavedashManager } from "./manager";

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
 * the game needing to handle it itself.
 *
 * Web Audio: subclass `AudioContext` so `ctx.destination` resolves to a master
 * GainNode that we control. The master gain wires to the real native destination,
 * so `node.connect(ctx.destination)` and any other game code is unaffected.
 *
 * HTML Media (`<audio>`/`<video>`): override `HTMLMediaElement.prototype.muted`
 * to record the game's intended state, but write `true` to the underlying element
 * whenever the SDK is muted. Tracked elements come from four sources:
 *  1. Pre-existing DOM media (`querySelectorAll`)
 *  2. `new Audio()` constructor shim (covers detached SFX)
 *  3. MutationObserver for any media added to the DOM later (covers innerHTML,
 *     framework rendering, createElement + append, etc.)
 *  4. `HTMLMediaElement.prototype.play()` shim — the universal point where an
 *     element starts producing audio. Catches anything driven purely via
 *     `.play()`/`.volume` (never assigning `.muted`, never entering the DOM,
 *     e.g. a PIXI/GDevelop intro video), force-muting it before playback begins
 *     regardless of how it was created — the one path the DOM-based sources and
 *     the `muted` setter all miss.
 *
 * Speech synthesis (`window.speechSynthesis`): bypasses both Web Audio and HTML
 * media entirely, so it gets its own shim — `speak()` forces the utterance's
 * native volume to 0 while muted.
 */
export class AudioManager extends WavedashManager {
  private _isMuted = false;

  // Web Audio contexts and their master gain nodes
  private contexts = new Map<AudioContext, GainNode>();

  // HTML media elements we know about + their game-intended muted state
  private elements = new WeakRefSet<HTMLMediaElement>();
  private intendedMuted = new WeakMap<HTMLMediaElement, boolean>();

  // Speech synthesis utterances + their game-intended volume
  private intendedUtteranceVolume = new WeakMap<
    SpeechSynthesisUtterance,
    number
  >();

  // Media elements already rerouted through Web Audio for capture. The
  // reroute (createMediaElementSource) is permanent per element, so we must
  // never attempt it twice — the second call throws InvalidStateError.
  private capturedElements = new WeakSet<HTMLMediaElement>();

  // Originals (restored on destroy)
  private originalAudioContext: typeof AudioContext | null = null;
  private originalWebKitAudioContext: typeof AudioContext | null = null;
  private originalAudio: typeof Audio | null = null;
  private originalMutedDescriptor: PropertyDescriptor | null = null;
  private originalPlay: typeof HTMLMediaElement.prototype.play | null = null;
  private originalSpeak: typeof SpeechSynthesis.prototype.speak | null = null;
  private originalUtteranceVolumeDescriptor: PropertyDescriptor | null = null;
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

  /**
   * Build a MediaStream audio tap of everything the game plays, for gameplay
   * capture (see ScreenCaptureManager). Returns the tap's audio tracks plus a
   * `dispose()` that tears down the capture-only graph edges.
   *
   * Everything already funnels through the per-context master GainNodes this
   * manager owns, so capture is just: master gain → MediaStreamDestination.
   * Multiple contexts are mixed into one destination on a "host" context,
   * bridging the others across via MediaStreamSource nodes (Web Audio nodes
   * can't connect across contexts directly).
   *
   * HTML media elements are rerouted into the host context's master gain via
   * createMediaElementSource. That reroute is permanent for the life of the
   * element (the Web Audio spec offers no undo), but it's transparent: output
   * still flows master gain → real destination, and both mute paths (native
   * `muted` + master-gain ramp) keep working. Cross-origin media without CORS
   * headers will tap as silence — same limitation as any Web Audio capture.
   *
   * Because the recording rides the master gains, captured audio respects the
   * user's mute state — matching what they actually hear.
   */
  createCaptureTap(): {
    tracks: MediaStreamTrack[];
    dispose: () => void;
  } | null {
    if (typeof window === "undefined") return null;

    // No game AudioContext yet? Create one (routed through our shim, so it
    // self-registers in `contexts`) — but only if there are media elements
    // worth tapping; otherwise there's simply no audio to capture.
    if (this.contexts.size === 0) {
      let hasMedia = false;
      this.elements.forEach(() => {
        hasMedia = true;
      });
      if (!hasMedia || !window.AudioContext) return null;
      try {
        void new window.AudioContext();
      } catch {
        return null;
      }
    }

    const entries = [...this.contexts.entries()];
    const hostEntry = entries[entries.length - 1];
    if (!hostEntry) return null;
    const [hostCtx, hostGain] = hostEntry;

    // Autoplay policy may have left contexts suspended; a capture request
    // implies a user gesture happened upstream, so nudge them awake.
    for (const [ctx] of entries) {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    }

    const captureDest = hostCtx.createMediaStreamDestination();
    const cleanups: (() => void)[] = [];

    for (const [ctx, gain] of entries) {
      if (ctx === hostCtx) {
        gain.connect(captureDest);
        cleanups.push(() => gain.disconnect(captureDest));
      } else {
        const bridgeDest = ctx.createMediaStreamDestination();
        gain.connect(bridgeDest);
        const bridgeSrc = hostCtx.createMediaStreamSource(bridgeDest.stream);
        bridgeSrc.connect(captureDest);
        cleanups.push(() => {
          gain.disconnect(bridgeDest);
          bridgeSrc.disconnect(captureDest);
        });
      }
    }

    // Reroute tracked HTML media into the host master gain so it lands in
    // the capture mix (and stays audible through master → real destination).
    this.elements.forEach((el) => {
      if (this.capturedElements.has(el)) return;
      try {
        const src = hostCtx.createMediaElementSource(el);
        src.connect(hostGain);
        this.capturedElements.add(el);
      } catch {
        // Element already claimed by another context, or CORS-restricted.
      }
    });

    return {
      tracks: captureDest.stream.getAudioTracks(),
      dispose: () => {
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {
            // Context may have been closed by the game mid-recording.
          }
        }
      }
    };
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
    this.sdk.gameEventManager.notifyGame(WavedashEvents.MUTE_CHANGED, {
      isMuted: this._isMuted
    } satisfies MuteChangedPayload);
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
      win.webkitAudioContext = this.shimAudioContextClass(
        win.webkitAudioContext
      );
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

    // 5. `HTMLMediaElement.prototype.play()` — the universal point where a media
    //    element starts producing audio. Tracking here force-mutes (when the SDK
    //    is muted) before playback begins, catching off-DOM elements driven via
    //    .play()/.volume that never assign .muted — the one path the DOM-based
    //    sources and the muted setter all miss.
    const originalPlay = HTMLMediaElement.prototype.play;
    this.originalPlay = originalPlay;
    ((manager) => {
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        manager.trackElement(this);
        return originalPlay.call(this);
      };
    })(this);

    // 6. Speech synthesis — bypasses Web Audio and HTML media entirely.
    this.shimSpeechSynthesis();
  }

  /**
   * Shim `window.speechSynthesis` so speech respects the SDK mute state.
   *
   * Never swallows speak(): utterances have a lifecycle the game may sequence
   * off (onstart/onend, synth.speaking/pending checks), so every call is
   * delegated and silenced via volume instead. Volume is sampled at speak()
   * time, so forcing the native value to 0 right before delegating silences
   * anything spoken while muted; in-flight speech at the mute edge is
   * deliberately left to finish (can't be softened mid-utterance, and
   * cancel() would discard the pending queue).
   */
  private shimSpeechSynthesis(): void {
    if (
      !window.speechSynthesis ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      return;
    }

    // `volume` descriptor: the game reads back its intended volume even
    // while we've written 0 to the native slot (mirrors the `muted` shim).
    // Game writes go through to the native slot too — speak() re-forces 0
    // if still muted, so order doesn't matter.
    this.originalUtteranceVolumeDescriptor =
      Object.getOwnPropertyDescriptor(
        SpeechSynthesisUtterance.prototype,
        "volume"
      ) ?? null;
    const volDesc = this.originalUtteranceVolumeDescriptor;
    if (volDesc?.get && volDesc?.set) {
      ((manager) => {
        Object.defineProperty(SpeechSynthesisUtterance.prototype, "volume", {
          configurable: true,
          get(this: SpeechSynthesisUtterance): number {
            const intended = manager.intendedUtteranceVolume.get(this);
            return intended !== undefined
              ? intended
              : (volDesc.get!.call(this) as number);
          },
          set(this: SpeechSynthesisUtterance, value: number) {
            manager.intendedUtteranceVolume.set(this, value);
            volDesc.set!.call(this, value);
          }
        });
      })(this);
    }

    // speak() wrapper: force native volume to 0 while muted; restore the
    // intended volume on unmuted speaks so a reused utterance object
    // doesn't stay silent after an earlier muted playthrough.
    const speechSynthesis = window.speechSynthesis;
    const originalSpeak = speechSynthesis.speak;
    this.originalSpeak = originalSpeak;
    ((manager) => {
      speechSynthesis.speak = function (utterance: SpeechSynthesisUtterance) {
        if (manager._isMuted) {
          if (!manager.intendedUtteranceVolume.has(utterance)) {
            const current = volDesc?.get
              ? (volDesc.get.call(utterance) as number)
              : utterance.volume;
            manager.intendedUtteranceVolume.set(utterance, current);
          }
          // Use the native setter where available — plain assignment would
          // route through our descriptor shim and record 0 as intended.
          if (volDesc?.set) volDesc.set.call(utterance, 0);
          else utterance.volume = 0;
        } else {
          const intended = manager.intendedUtteranceVolume.get(utterance);
          if (intended !== undefined) {
            if (volDesc?.set) volDesc.set.call(utterance, intended);
            else utterance.volume = intended;
            // Native slot now equals intended, so the map entry is
            // redundant — drop it; future game writes re-record.
            manager.intendedUtteranceVolume.delete(utterance);
          }
        }
        return originalSpeak.call(speechSynthesis, utterance);
      };
    })(this);
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
      if (this.originalSpeak && window.speechSynthesis) {
        window.speechSynthesis.speak = this.originalSpeak;
      }
    }

    if (
      this.originalUtteranceVolumeDescriptor &&
      typeof SpeechSynthesisUtterance !== "undefined"
    ) {
      Object.defineProperty(
        SpeechSynthesisUtterance.prototype,
        "volume",
        this.originalUtteranceVolumeDescriptor
      );
    }

    if (this.originalPlay) {
      HTMLMediaElement.prototype.play = this.originalPlay;
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
    this.intendedUtteranceVolume = new WeakMap();

    super.destroy();
  }
}
