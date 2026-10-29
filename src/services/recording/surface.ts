import type { FrameWindow } from "../../utils/sameOriginFrames";

export const MAX_TRACKS = 8;
const WAVEDASH_UI_SELECTOR = "[data-wavedash]";
const GAME_TARGET_ID = "wavedash-target";
const COVER_TOLERANCE_PX = 1;
const MIN_CONTROL_AREA_PX = 4;

export const WAVEDASH_UI_BLOCK_SELECTOR = [
  `${WAVEDASH_UI_SELECTOR}:not(:has(#${GAME_TARGET_ID}))`,
  `${WAVEDASH_UI_SELECTOR} :not(#${GAME_TARGET_ID}, #${GAME_TARGET_ID} *, :has(#${GAME_TARGET_ID}))`
].join(", ");

const NON_RENDERED = new Set([
  "HEAD",
  "SCRIPT",
  "STYLE",
  "LINK",
  "META",
  "TITLE",
  "NOSCRIPT",
  "TEMPLATE"
]);
const MEDIA_ELEMENTS = new Set([
  "IMG",
  "VIDEO",
  "SVG",
  "OBJECT",
  "EMBED",
  "PROGRESS",
  "METER"
]);
const FORM_CONTROLS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

export interface CaptureCanvas {
  canvas: HTMLCanvasElement;
  win: FrameWindow;
  visibleArea: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function parentAcrossFrames(
  element: Element,
  win: FrameWindow,
  top: FrameWindow
): [Element, FrameWindow] | null {
  if (element.parentElement) return [element.parentElement, win];
  if (win === top || !win.frameElement) return null;
  return [win.frameElement, win.parent as FrameWindow];
}

function topRect(element: Element, win: FrameWindow, top: FrameWindow): Rect {
  const rect = element.getBoundingClientRect();
  let x = 0;
  let y = 0;
  let current = win;
  while (current !== top) {
    const frame = current.frameElement!;
    const frameRect = frame.getBoundingClientRect();
    x += frameRect.left + frame.clientLeft;
    y += frameRect.top + frame.clientTop;
    current = current.parent as FrameWindow;
  }
  return {
    left: rect.left + x,
    top: rect.top + y,
    right: rect.right + x,
    bottom: rect.bottom + y
  };
}

function visibleArea(rect: Rect, top: FrameWindow): number {
  const width = Math.min(rect.right, top.innerWidth) - Math.max(rect.left, 0);
  const height = Math.min(rect.bottom, top.innerHeight) - Math.max(rect.top, 0);
  return Math.max(0, width) * Math.max(0, height);
}

function isHidden(
  element: Element,
  win: FrameWindow,
  top: FrameWindow
): boolean {
  if (element.getClientRects().length === 0) return true;
  const visibility = win.getComputedStyle(element).visibility;
  if (visibility === "hidden" || visibility === "collapse") return true;
  let current: [Element, FrameWindow] | null = [element, win];
  while (current) {
    const [node, nodeWin] = current;
    if (parseFloat(nodeWin.getComputedStyle(node).opacity) === 0) return true;
    current = parentAcrossFrames(node, nodeWin, top);
  }
  return false;
}

export function findCaptureCanvases(
  windows: Iterable<FrameWindow>,
  top: FrameWindow
): CaptureCanvas[] {
  const found: CaptureCanvas[] = [];
  for (const win of windows) {
    win.document.querySelectorAll("canvas").forEach((canvas) => {
      if (canvas.width === 0 || canvas.height === 0) return;
      if (isHidden(canvas, win, top)) return;
      const area = visibleArea(topRect(canvas, win, top), top);
      if (area > 0) found.push({ canvas, win, visibleArea: area });
    });
  }
  return found
    .sort(
      (a, b) =>
        b.visibleArea - a.visibleArea ||
        b.canvas.width * b.canvas.height - a.canvas.width * a.canvas.height
    )
    .slice(0, MAX_TRACKS);
}

function alpha(color: string): number {
  if (!color || color === "transparent") return 0;
  const match = /rgba?\(([^)]+)\)/.exec(color);
  if (!match) return 1;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const value = parts[3];
  return value.endsWith("%") ? parseFloat(value) / 100 : parseFloat(value);
}

function paintsBox(style: CSSStyleDeclaration): boolean {
  if (alpha(style.backgroundColor) > 0) return true;
  if (style.backgroundImage && style.backgroundImage !== "none") return true;
  if (style.boxShadow && style.boxShadow !== "none") return true;
  for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
    if (
      parseFloat(style[`border${side}Width`]) > 0 &&
      style[`border${side}Style`] !== "none" &&
      style[`border${side}Style`] !== "hidden" &&
      alpha(style[`border${side}Color`]) > 0
    ) {
      return true;
    }
  }
  return (
    parseFloat(style.outlineWidth) > 0 &&
    style.outlineStyle !== "none" &&
    alpha(style.outlineColor) > 0
  );
}

function paintsText(element: Element, style: CSSStyleDeclaration): boolean {
  if (alpha(style.color) === 0 || parseFloat(style.fontSize) === 0)
    return false;
  return Array.from(element.childNodes).some(
    (node) => node.nodeType === 3 && node.textContent!.trim() !== ""
  );
}

function paintsPseudo(element: Element, win: FrameWindow): boolean {
  return ["::before", "::after"].some((pseudo) => {
    const style = win.getComputedStyle(element, pseudo);
    const content = style.content;
    if (!content || content === "none" || content === "normal") return false;
    return paintsBox(style) || (content !== '""' && alpha(style.color) > 0);
  });
}

function paintsControl(
  element: Element,
  style: CSSStyleDeclaration,
  area: number
): boolean {
  const type = element.getAttribute("type")?.toLowerCase();
  if (type === "file" || type === "hidden") return false;
  if (area < MIN_CONTROL_AREA_PX) return false;
  if (paintsBox(style)) return true;
  const control = element as HTMLInputElement;
  const text =
    control.value || control.placeholder || element.textContent || "";
  return text.trim() !== "" && alpha(style.color) > 0;
}

function isWavedashUi(element: Element): boolean {
  const ui = element.closest(WAVEDASH_UI_SELECTOR);
  if (!ui) return false;
  const target = ui.querySelector(`#${GAME_TARGET_ID}`);
  return !target || (target !== element && !target.contains(element));
}

function coversViewport(rect: Rect, top: FrameWindow): boolean {
  return (
    rect.left <= COVER_TOLERANCE_PX &&
    rect.top <= COVER_TOLERANCE_PX &&
    rect.right >= top.innerWidth - COVER_TOLERANCE_PX &&
    rect.bottom >= top.innerHeight - COVER_TOLERANCE_PX
  );
}

export function detectHasDom(
  windows: Iterable<FrameWindow>,
  top: FrameWindow,
  canvases: CaptureCanvas[]
): boolean {
  const captured = new Set<Element>(canvases.map((c) => c.canvas));
  const ancestors = new Set<Element>();
  for (const { canvas, win } of canvases) {
    let current = parentAcrossFrames(canvas, win, top);
    while (current) {
      ancestors.add(current[0]);
      current = parentAcrossFrames(current[0], current[1], top);
    }
  }
  const covered = canvases.some(({ canvas, win }) =>
    coversViewport(topRect(canvas, win, top), top)
  );
  const sameOrigin = new Set<FrameWindow>(windows);
  for (const win of sameOrigin) {
    for (const element of Array.from(win.document.querySelectorAll("*"))) {
      if (captured.has(element)) continue;
      const tag = element.tagName.toUpperCase();
      if (NON_RENDERED.has(tag) || element.closest("head")) continue;
      if (isWavedashUi(element)) continue;
      if (isHidden(element, win, top)) continue;
      const area = visibleArea(topRect(element, win, top), top);
      if (area === 0) continue;
      const style = win.getComputedStyle(element);
      if (tag === "IFRAME") {
        const child = (element as HTMLIFrameElement).contentWindow;
        if (!child || !sameOrigin.has(child as FrameWindow)) return true;
        if (!ancestors.has(element) && paintsBox(style)) return true;
        continue;
      }
      if (tag === "CANVAS") return true;
      if (ancestors.has(element)) {
        if (paintsText(element, style)) return true;
        if (!covered && paintsBox(style)) return true;
        continue;
      }
      if (MEDIA_ELEMENTS.has(tag)) return true;
      if (FORM_CONTROLS.has(tag)) {
        if (paintsControl(element, style, area)) return true;
        continue;
      }
      if (paintsBox(style) || paintsText(element, style)) return true;
      if (paintsPseudo(element, win)) return true;
    }
  }
  return false;
}

const PLACEHOLDER_PROBE_CONTEXT = "wavedash-placeholder-probe";

export function isTransferredCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    canvas.getContext(PLACEHOLDER_PROBE_CONTEXT as "2d");
    return false;
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      return true;
    }
    throw error;
  }
}
