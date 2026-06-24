import { IFRAME_MESSAGE_TYPE } from "@wvdsh/api";
import { WavedashEvents } from "../events";
import { type WavedashSDK } from "../index";
import type { MuteChangedPayload } from "../types";
import { hasParentContext } from "../utils/parentContext";
import { WavedashManager } from "./manager";

/**
 * Mutes & unmutes the game in response to MUTE_CHANGED iframe messages, with no
 * game-side code required.
 *
 * Globals like `AudioContext` are per-frame, so we shim the SDK's own window
 * (where the game usually runs) plus any same-origin iframes the game adds.
 *
 * Each frame's shimming lives in {@link AudioFrameShim}; this class owns the
 * mute state and fans it out to every attached frame.
 */
export class AudioManager extends WavedashManager {
  private _isMuted = false;

  // One shim per frame we've attached to.
  private frames = new Set<AudioFrameShim>();

  // Per-iframe state so we can re-shim across navigations/swaps and tear down
  // the right frame when an iframe is removed or re-navigates. Keyed on the
  // Document (replaced on every navigation), not contentWindow (a stable
  // WindowProxy that survives navigations and so can't reveal a realm change).
  private iframeBindings = new WeakMap<
    HTMLIFrameElement,
    { doc: Document; shim: AudioFrameShim }
  >();
  private iframeLoadHandlers = new Map<HTMLIFrameElement, () => void>();
  private boundIframes = new Set<HTMLIFrameElement>();

  constructor(sdk: WavedashSDK) {
    super(sdk);
    if (typeof window !== "undefined") {
      this.attachWindow(window);
    }
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
    // Mute is owned by the parent UI; disabled outside a Wavedash parent frame.
    if (!hasParentContext()) return false;
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
    if (!hasParentContext()) return false;
    const response = await this.sdk.iframeMessenger.requestFromParent(
      IFRAME_MESSAGE_TYPE.TOGGLE_MUTE
    );
    return response.success;
  }

  private handleMute = (data: { isMuted: boolean }): void => {
    if (this._isMuted === data.isMuted) return;
    this._isMuted = data.isMuted;

    this.frames.forEach((shim) => shim.applyMute(this._isMuted));

    // Notify game in case it needs to update in-game UI.
    this.sdk.gameEventManager.notifyGame(WavedashEvents.MUTE_CHANGED, {
      isMuted: this._isMuted
    } satisfies MuteChangedPayload);
  };

  /** Shim a window we can reach. Same-origin only (cross-origin access throws). */
  private attachWindow(win: Window): void {
    try {
      // Accessing `document` throws a SecurityError for cross-origin frames.
      void win.document;
    } catch {
      return; // cross-origin — nothing we can shim
    }
    const shim = new AudioFrameShim(this, win as FrameWindow);
    this.frames.add(shim);
  }

  /**
   * Start tracking an iframe: attach now (already-loaded frames) and on every
   * `load` (about:blank → game, and later src swaps). Idempotent.
   */
  bindIframe(iframe: HTMLIFrameElement): void {
    if (!this.boundIframes.has(iframe)) {
      this.boundIframes.add(iframe);
      const onLoad = (): void => this.attachIframe(iframe);
      this.iframeLoadHandlers.set(iframe, onLoad);
      iframe.addEventListener("load", onLoad);
    }
    this.attachIframe(iframe);
  }

  /** Stop tracking an iframe and tear down its frame (iframe removed from DOM). */
  unbindIframe(iframe: HTMLIFrameElement): void {
    const handler = this.iframeLoadHandlers.get(iframe);
    if (handler) {
      iframe.removeEventListener("load", handler);
      this.iframeLoadHandlers.delete(iframe);
    }
    this.boundIframes.delete(iframe);
    this.teardownFrame(iframe);
  }

  /**
   * Install (or re-install) a shim for an iframe's current document. No-ops
   * while not yet navigated or already shimmed; replaces the previous shim when
   * the iframe navigates to a fresh document, and drops it when it goes
   * cross-origin (we can no longer reach it).
   */
  private attachIframe(iframe: HTMLIFrameElement): void {
    let win: FrameWindow | null = null;
    let doc: Document | null = null;
    try {
      const cw = iframe.contentWindow as FrameWindow | null;
      if (cw) {
        // contentWindow is a stable WindowProxy across navigations, so the
        // document — which is replaced each navigation — is what reveals a
        // realm change. Reading it also throws for cross-origin frames.
        doc = cw.document;
        win = cw;
      }
    } catch {
      // Cross-origin: leave win/doc null and fall through to teardown.
    }

    // Unreachable (detached from the DOM, not yet navigated, or cross-origin):
    // drop any shim we held for this iframe's previous document so handleMute
    // never iterates a dead context.
    if (!win || !doc) {
      this.teardownFrame(iframe);
      return;
    }

    const existing = this.iframeBindings.get(iframe);
    if (existing) {
      if (existing.doc === doc) return; // this document is already shimmed
      // Navigated to a fresh document (about:blank → game, demo → full, …):
      // the previous realm's globals are gone, so replace its shim.
      this.teardownFrame(iframe);
    }

    const shim = new AudioFrameShim(this, win);
    this.frames.add(shim);
    this.iframeBindings.set(iframe, { doc, shim });
    if (this._isMuted) shim.applyMute(true);
  }

  /** Remove and uninstall the shim bound to an iframe's (previous) document. */
  private teardownFrame(iframe: HTMLIFrameElement): void {
    const binding = this.iframeBindings.get(iframe);
    if (!binding) return;
    this.frames.delete(binding.shim);
    binding.shim.uninstall();
    this.iframeBindings.delete(iframe);
  }

  override destroy(): void {
    this.sdk.iframeMessenger.removeEventListener(
      IFRAME_MESSAGE_TYPE.MUTE_CHANGED,
      this.handleMute
    );

    this.boundIframes.forEach((iframe) => {
      const handler = this.iframeLoadHandlers.get(iframe);
      if (handler) iframe.removeEventListener("load", handler);
    });
    this.boundIframes.clear();
    this.iframeLoadHandlers.clear();

    this.frames.forEach((shim) => shim.uninstall());
    this.frames.clear();

    super.destroy();
  }
}

/** A same-origin frame's window, with its globals typed. */
type FrameWindow = Window & typeof globalThis;

/**
 * Installs the mute shims into one frame (window) and tracks the audio it
 * produces. The mute state lives on the owning {@link AudioManager}; each shim
 * reads `manager.isMuted()` and the manager pushes changes via {@link applyMute}.
 *
 * We shim three independent audio paths:
 * - Web Audio: subclass `AudioContext` so `ctx.destination` is a master GainNode
 *   we control (wired to the real destination, so game code is unaffected).
 * - HTML media (`<audio>`/`<video>`): the `muted` setter records the game's
 *   intended value but forces the element muted while the SDK is muted. Elements
 *   are found via existing DOM, the `new Audio()` shim, a MutationObserver, and a
 *   `play()` shim (the last catches off-DOM elements driven only by `.play()`).
 * - Speech synthesis: `speak()` forces the utterance volume to 0 while muted.
 *
 * The MutationObserver also reports nested iframes to the manager so child frames
 * get their own shim.
 */
class AudioFrameShim {
  private manager: AudioManager;
  readonly win: FrameWindow;
  private doc: Document | null;

  private contexts = new Map<AudioContext, GainNode>();

  // Tracked media elements + the game's intended muted value (what it last set).
  private elements = new WeakRefSet<HTMLMediaElement>();
  private intendedMuted = new WeakMap<HTMLMediaElement, boolean>();

  // Utterances + the game's intended volume.
  private intendedUtteranceVolume = new WeakMap<
    SpeechSynthesisUtterance,
    number
  >();

  // Child iframes discovered in this frame's document. Tracked so we can
  // cascade-unbind them when this frame is torn down — their own removal events
  // never fire when the containing document is discarded wholesale.
  private boundChildren = new Set<HTMLIFrameElement>();

  // Originals, restored on uninstall.
  private originalAudioContext: typeof AudioContext | null = null;
  private originalWebKitAudioContext: typeof AudioContext | null = null;
  private originalAudio: typeof Audio | null = null;
  private originalMutedDescriptor: PropertyDescriptor | null = null;
  private originalPlay: typeof HTMLMediaElement.prototype.play | null = null;
  private originalSpeak: typeof SpeechSynthesis.prototype.speak | null = null;
  private originalUtteranceVolumeDescriptor: PropertyDescriptor | null = null;
  private mutationObserver: MutationObserver | null = null;

  constructor(manager: AudioManager, win: FrameWindow) {
    this.manager = manager;
    this.win = win;
    this.doc = win.document ?? null;
    this.installShims();
  }

  /** Push the current mute state onto everything this frame is tracking. */
  applyMute(isMuted: boolean): void {
    // Short ramp avoids pops; cancelScheduledValues drops any in-flight ramp.
    const target = isMuted ? 0 : 1;
    this.contexts.forEach((gain, ctx) => {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(target, now + 0.05);
    });

    const setMutedNative = this.originalMutedDescriptor?.set;
    if (setMutedNative) {
      this.elements.forEach((el) => {
        const intended = this.intendedMuted.get(el) ?? false;
        setMutedNative.call(el, isMuted ? true : intended);
      });
    }
  }

  /** Hand a discovered child iframe to the manager, remembering it for teardown. */
  private bindChild(iframe: HTMLIFrameElement): void {
    this.boundChildren.add(iframe);
    this.manager.bindIframe(iframe);
  }

  /** Stop tracking a child iframe that was removed from this document. */
  private unbindChild(iframe: HTMLIFrameElement): void {
    this.boundChildren.delete(iframe);
    this.manager.unbindIframe(iframe);
  }

  /** Track a media element and silence it if currently muted. Idempotent. */
  private trackElement(el: HTMLMediaElement): void {
    if (this.intendedMuted.has(el)) return;
    const getMuted = this.originalMutedDescriptor?.get;
    const setMuted = this.originalMutedDescriptor?.set;
    const current = getMuted ? (getMuted.call(el) as boolean) : el.muted;
    this.intendedMuted.set(el, current);
    this.elements.add(el);
    if (this.manager.isMuted() && !current && setMuted) {
      setMuted.call(el, true);
    }
  }

  private installShims(): void {
    const win = this.win;
    const doc = this.doc;

    // AudioContext (+ webkit prefix): subclass to redirect destination.
    if (win.AudioContext) {
      this.originalAudioContext = win.AudioContext;
      win.AudioContext = this.shimAudioContextClass(win.AudioContext);
    }
    const w = win as FrameWindow & {
      webkitAudioContext?: typeof AudioContext;
    };
    if (w.webkitAudioContext) {
      this.originalWebKitAudioContext = w.webkitAudioContext;
      w.webkitAudioContext = this.shimAudioContextClass(w.webkitAudioContext);
    }

    // `new Audio()`: catches detached SFX that never enter the DOM.
    if (win.Audio) {
      const OriginalAudio = win.Audio;
      this.originalAudio = OriginalAudio;
      ((shim) => {
        const Shimmed = function (src?: string) {
          const audio = new OriginalAudio(src);
          shim.trackElement(audio);
          return audio;
        };
        Shimmed.prototype = OriginalAudio.prototype;
        win.Audio = Shimmed as unknown as typeof Audio;
      })(this);
    }

    if (doc) {
      const HTMLMediaElementCtor = win.HTMLMediaElement;
      const HTMLIFrameElementCtor = win.HTMLIFrameElement;
      const HTMLElementCtor = win.HTMLElement;

      // Existing media + iframes.
      doc.querySelectorAll("audio, video").forEach((el) => {
        this.trackElement(el as HTMLMediaElement);
      });
      doc.querySelectorAll("iframe").forEach((el) => {
        this.bindChild(el as HTMLIFrameElement);
      });

      // Media and iframes added/removed later.
      this.mutationObserver = new win.MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) => {
            if (node instanceof HTMLMediaElementCtor) {
              this.trackElement(node as HTMLMediaElement);
            } else if (node instanceof HTMLIFrameElementCtor) {
              this.bindChild(node as HTMLIFrameElement);
            } else if (node instanceof HTMLElementCtor) {
              const el = node as HTMLElement;
              el.querySelectorAll("audio, video").forEach((m2) => {
                this.trackElement(m2 as HTMLMediaElement);
              });
              el.querySelectorAll("iframe").forEach((f) => {
                this.bindChild(f as HTMLIFrameElement);
              });
            }
          });
          m.removedNodes.forEach((node) => {
            if (node instanceof HTMLIFrameElementCtor) {
              this.unbindChild(node as HTMLIFrameElement);
            } else if (node instanceof HTMLElementCtor) {
              (node as HTMLElement).querySelectorAll("iframe").forEach((f) => {
                this.unbindChild(f as HTMLIFrameElement);
              });
            }
          });
        }
      });
      this.mutationObserver.observe(doc.documentElement, {
        childList: true,
        subtree: true
      });
    }

    // `muted` setter: game reads back its intended value, element stays muted.
    this.originalMutedDescriptor =
      Object.getOwnPropertyDescriptor(
        win.HTMLMediaElement.prototype,
        "muted"
      ) ?? null;
    const original = this.originalMutedDescriptor;
    if (original?.get && original?.set) {
      ((shim) => {
        Object.defineProperty(win.HTMLMediaElement.prototype, "muted", {
          configurable: true,
          get(this: HTMLMediaElement): boolean {
            const intended = shim.intendedMuted.get(this);
            return intended !== undefined ? intended : original.get!.call(this);
          },
          set(this: HTMLMediaElement, value: boolean) {
            shim.intendedMuted.set(this, value);
            shim.elements.add(this);
            original.set!.call(this, shim.manager.isMuted() ? true : value);
          }
        });
      })(this);
    }

    // `play()`: force-mute before playback for elements only driven via play().
    const originalPlay = win.HTMLMediaElement.prototype.play;
    this.originalPlay = originalPlay;
    ((shim) => {
      win.HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        shim.trackElement(this);
        return originalPlay.call(this);
      };
    })(this);

    this.shimSpeechSynthesis();
  }

  /**
   * Shim `speechSynthesis`. We never swallow `speak()` (games sequence off its
   * lifecycle) — instead we sample volume at call time and force it to 0 while
   * muted. Speech already in flight at the mute edge is left to finish.
   */
  private shimSpeechSynthesis(): void {
    const win = this.win;
    if (
      !win.speechSynthesis ||
      typeof win.SpeechSynthesisUtterance === "undefined"
    ) {
      return;
    }

    // `volume` descriptor: game reads back its intended value (mirrors `muted`).
    this.originalUtteranceVolumeDescriptor =
      Object.getOwnPropertyDescriptor(
        win.SpeechSynthesisUtterance.prototype,
        "volume"
      ) ?? null;
    const volDesc = this.originalUtteranceVolumeDescriptor;
    if (volDesc?.get && volDesc?.set) {
      ((shim) => {
        Object.defineProperty(
          win.SpeechSynthesisUtterance.prototype,
          "volume",
          {
            configurable: true,
            get(this: SpeechSynthesisUtterance): number {
              const intended = shim.intendedUtteranceVolume.get(this);
              return intended !== undefined
                ? intended
                : (volDesc.get!.call(this) as number);
            },
            set(this: SpeechSynthesisUtterance, value: number) {
              shim.intendedUtteranceVolume.set(this, value);
              volDesc.set!.call(this, value);
            }
          }
        );
      })(this);
    }

    const speechSynthesis = win.speechSynthesis;
    const originalSpeak = speechSynthesis.speak;
    this.originalSpeak = originalSpeak;
    ((shim) => {
      speechSynthesis.speak = function (utterance: SpeechSynthesisUtterance) {
        if (shim.manager.isMuted()) {
          if (!shim.intendedUtteranceVolume.has(utterance)) {
            const current = volDesc?.get
              ? (volDesc.get.call(utterance) as number)
              : utterance.volume;
            shim.intendedUtteranceVolume.set(utterance, current);
          }
          // Native setter, so we don't record 0 as the intended volume.
          if (volDesc?.set) volDesc.set.call(utterance, 0);
          else utterance.volume = 0;
        } else {
          const intended = shim.intendedUtteranceVolume.get(utterance);
          if (intended !== undefined) {
            if (volDesc?.set) volDesc.set.call(utterance, intended);
            else utterance.volume = intended;
            shim.intendedUtteranceVolume.delete(utterance);
          }
        }
        return originalSpeak.call(speechSynthesis, utterance);
      };
    })(this);
  }

  private shimAudioContextClass(
    Original: typeof AudioContext
  ): typeof AudioContext {
    return ((shim) =>
      class extends Original {
        constructor(opts?: AudioContextOptions) {
          super(opts);
          const masterGain = this.createGain();
          masterGain.connect(this.destination);
          masterGain.gain.setValueAtTime(
            shim.manager.isMuted() ? 0 : 1,
            this.currentTime
          );
          // Redirect ctx.destination → masterGain; node.connect(destination) still works.
          Object.defineProperty(this, "destination", {
            configurable: true,
            get() {
              return masterGain;
            }
          });
          shim.contexts.set(this, masterGain);
        }

        close(): Promise<void> {
          shim.contexts.delete(this);
          return super.close();
        }
      })(this);
  }

  /**
   * Restore the globals we patched. Best-effort per statement: a frame reached
   * through an iframe may have navigated away (globals gone) before teardown.
   */
  uninstall(): void {
    const win = this.win;

    try {
      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }
    } catch {
      // best-effort
    }

    // Cascade into child iframes: their containing document is going away, so
    // their own removal events won't fire. unbindIframe recurses into their
    // shims, unwinding the whole subtree.
    this.boundChildren.forEach((child) => this.manager.unbindIframe(child));
    this.boundChildren.clear();

    const restore = (fn: () => void): void => {
      try {
        fn();
      } catch {
        // best-effort
      }
    };

    restore(() => {
      if (this.originalAudioContext)
        win.AudioContext = this.originalAudioContext;
    });
    restore(() => {
      const w = win as FrameWindow & {
        webkitAudioContext?: typeof AudioContext;
      };
      if (this.originalWebKitAudioContext && w.webkitAudioContext) {
        w.webkitAudioContext = this.originalWebKitAudioContext;
      }
    });
    restore(() => {
      if (this.originalAudio) win.Audio = this.originalAudio;
    });
    restore(() => {
      if (this.originalSpeak && win.speechSynthesis) {
        win.speechSynthesis.speak = this.originalSpeak;
      }
    });
    restore(() => {
      if (
        this.originalUtteranceVolumeDescriptor &&
        typeof win.SpeechSynthesisUtterance !== "undefined"
      ) {
        Object.defineProperty(
          win.SpeechSynthesisUtterance.prototype,
          "volume",
          this.originalUtteranceVolumeDescriptor
        );
      }
    });
    restore(() => {
      if (this.originalPlay) {
        win.HTMLMediaElement.prototype.play = this.originalPlay;
      }
    });
    restore(() => {
      if (this.originalMutedDescriptor) {
        Object.defineProperty(
          win.HTMLMediaElement.prototype,
          "muted",
          this.originalMutedDescriptor
        );
      }
    });

    this.contexts.clear();
    this.elements.clear();
    this.intendedMuted = new WeakMap();
    this.intendedUtteranceVolume = new WeakMap();
  }
}

/** Set of WeakRefs that lets us iterate without pinning entries; stale refs are purged on iterate. */
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
