import { logger } from "./logger";

// A same-origin frame's window, with its globals typed
export type FrameWindow = Window & typeof globalThis;

export interface FrameListener {
  attach: (win: FrameWindow) => void;
  detach: (win: FrameWindow) => void;
}

interface FrameRecord {
  observer: MutationObserver;
  children: Set<HTMLIFrameElement>;
}

// Tracks the SDK's window plus every same-origin iframe beneath it, across loads, navigations and removals
export class SameOriginFrames {
  private listeners = new Set<FrameListener>();
  private frames = new Map<FrameWindow, FrameRecord>();
  // Keyed on the Document, since contentWindow is a WindowProxy that survives navigations
  private iframeBindings = new WeakMap<
    HTMLIFrameElement,
    { win: FrameWindow; doc: Document }
  >();
  private iframeLoadHandlers = new Map<HTMLIFrameElement, () => void>();

  constructor() {
    if (typeof window !== "undefined") this.attachFrame(window);
  }

  // Attaches every current frame immediately, then reports changes; returns an unsubscribe
  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    this.frames.forEach((_, win) => this.notify(listener, "attach", win));
    return () => {
      this.listeners.delete(listener);
    };
  }

  // One subscriber throwing must not block the others or leave frame state half-updated
  private notify(
    listener: FrameListener,
    event: keyof FrameListener,
    win: FrameWindow
  ): void {
    try {
      listener[event](win);
    } catch (error) {
      logger.error(`SameOriginFrames: ${event} subscriber threw`, error);
    }
  }

  private attachFrame(win: FrameWindow): void {
    const doc = win.document;
    const record: FrameRecord = {
      observer: new win.MutationObserver((mutations) => {
        for (const m of mutations) {
          m.addedNodes.forEach((node) =>
            this.iframesIn(win, node).forEach((iframe) =>
              this.bindIframe(iframe, record)
            )
          );
          m.removedNodes.forEach((node) =>
            this.iframesIn(win, node).forEach((iframe) =>
              this.unbindIframe(iframe, record)
            )
          );
        }
      }),
      children: new Set()
    };
    this.frames.set(win, record);
    this.listeners.forEach((listener) => this.notify(listener, "attach", win));
    doc
      .querySelectorAll("iframe")
      .forEach((iframe) => this.bindIframe(iframe, record));
    record.observer.observe(doc.documentElement, {
      childList: true,
      subtree: true
    });
  }

  private detachFrame(win: FrameWindow): void {
    const record = this.frames.get(win);
    if (!record) return;
    record.observer.disconnect();
    // Children's own removal events never fire when their containing document is discarded
    record.children.forEach((child) => this.unbindIframe(child, record));
    this.frames.delete(win);
    this.listeners.forEach((listener) => this.notify(listener, "detach", win));
  }

  // Skips the subtree scan for childless nodes, the common case on every DOM insertion
  private iframesIn(win: FrameWindow, node: Node): HTMLIFrameElement[] {
    if (node instanceof win.HTMLIFrameElement) return [node];
    if (!(node instanceof win.HTMLElement) || !node.firstElementChild)
      return [];
    return Array.from(node.querySelectorAll("iframe"));
  }

  private bindIframe(iframe: HTMLIFrameElement, parent: FrameRecord): void {
    if (!parent.children.has(iframe)) {
      parent.children.add(iframe);
      const onLoad = (): void => this.attachIframe(iframe);
      this.iframeLoadHandlers.set(iframe, onLoad);
      iframe.addEventListener("load", onLoad);
    }
    this.attachIframe(iframe);
  }

  private unbindIframe(iframe: HTMLIFrameElement, parent: FrameRecord): void {
    const onLoad = this.iframeLoadHandlers.get(iframe);
    if (onLoad) iframe.removeEventListener("load", onLoad);
    this.iframeLoadHandlers.delete(iframe);
    parent.children.delete(iframe);
    this.detachIframe(iframe);
  }

  // Re-attaches when the iframe navigates to a fresh document; detaches when it becomes unreachable
  private attachIframe(iframe: HTMLIFrameElement): void {
    let win: FrameWindow | null = null;
    let doc: Document | null = null;
    try {
      win = iframe.contentWindow as FrameWindow | null;
      doc = win?.document ?? null;
    } catch {
      win = null;
    }
    if (!win || !doc) {
      this.detachIframe(iframe);
      return;
    }
    const existing = this.iframeBindings.get(iframe);
    if (existing?.doc === doc) return;
    if (existing) this.detachIframe(iframe);
    this.iframeBindings.set(iframe, { win, doc });
    this.attachFrame(win);
  }

  private detachIframe(iframe: HTMLIFrameElement): void {
    const binding = this.iframeBindings.get(iframe);
    if (!binding) return;
    this.iframeBindings.delete(iframe);
    this.detachFrame(binding.win);
  }

  destroy(): void {
    this.frames.forEach((record) => record.observer.disconnect());
    this.frames.clear();
    this.iframeLoadHandlers.forEach((onLoad, iframe) =>
      iframe.removeEventListener("load", onLoad)
    );
    this.iframeLoadHandlers.clear();
    this.listeners.clear();
  }
}
