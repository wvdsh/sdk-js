import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  detectHasDom,
  findCaptureCanvases,
  isTransferredCanvas,
  MAX_TRACKS
} from "../../../services/recording/surface";
import type { FrameWindow } from "../../../utils/sameOriginFrames";

const VIEWPORT = "0,0,1024,768";
const win = window as unknown as FrameWindow;

const originalRect = Element.prototype.getBoundingClientRect;
const originalRects = Element.prototype.getClientRects;

function rectOf(element: Element): DOMRect {
  const tag = element.tagName.toUpperCase();
  const spec =
    element.getAttribute("data-rect") ??
    (tag === "HTML" || tag === "BODY" ? VIEWPORT : "0,0,0,0");
  const [x, y, width, height] = spec.split(",").map(Number);
  return new DOMRect(x, y, width, height);
}

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function () {
    return rectOf(this);
  };
  Element.prototype.getClientRects = function () {
    const rect = rectOf(this);
    return (rect.width > 0 && rect.height > 0
      ? [rect]
      : []) as unknown as DOMRectList;
  };
});

afterAll(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  Element.prototype.getClientRects = originalRects;
});

beforeEach(() => {
  document.body.setAttribute(
    "style",
    "background-color: rgb(0, 0, 0); color: rgb(0, 0, 0)"
  );
});

function embedShell(target: string, extra = ""): string {
  return `<div id="app" data-wavedash data-rect="${VIEWPORT}">
    <div class="size-full" data-rect="${VIEWPORT}">${extra}
      <div id="wavedash-target" data-rect="${VIEWPORT}">${target}</div>
    </div>
  </div>`;
}

const fullCanvas = `<canvas id="game" width="1024" height="768" style="outline: none" data-rect="${VIEWPORT}"></canvas>`;

function analyze(html: string) {
  document.body.innerHTML = html;
  const canvases = findCaptureCanvases([win], win);
  return { canvases, hasDom: detectHasDom([win], win, canvases) };
}

describe("detectHasDom", () => {
  it("Unity default entrypoint is canvas-only", () => {
    const { canvases, hasDom } = analyze(embedShell(fullCanvas));
    expect(canvases.map((c) => c.canvas.id)).toEqual(["game"]);
    expect(hasDom).toBe(false);
  });

  it("ignores the embed loading spinner", () => {
    const spinner = `<div class="spinner" data-rect="${VIEWPORT}"><svg data-rect="496,368,32,32"></svg></div>`;
    expect(analyze(embedShell(fullCanvas, spinner)).hasDom).toBe(false);
  });

  it("Godot 4 default with hidden IME and virtual keyboard inputs is canvas-only", () => {
    const helpers = `
      <div class="ime" style="opacity: 0; font-size: 1px; color: rgb(0, 0, 0)" data-rect="0,0,1024,40">composition</div>
      <input style="display: none">
      <textarea style="width: 0px; height: 0px; border: 0px"></textarea>`;
    expect(analyze(embedShell(fullCanvas + helpers)).hasDom).toBe(false);
  });

  it("ignores a tiny transparent mobile-keyboard input and file inputs", () => {
    const helpers = `
      <input style="background-color: transparent; border: 0px" data-rect="4,4,1,1">
      <input type="file" style="border: 1px solid rgb(0, 0, 0)" data-rect="0,0,200,24">`;
    expect(analyze(embedShell(fullCanvas + helpers)).hasDom).toBe(false);
  });

  it("ignores Wavedash UI such as the dev paywall overlay", () => {
    const overlay = `<div data-wavedash style="background-color: rgba(8, 10, 18, 0.72)" data-rect="${VIEWPORT}"><p style="color: rgb(255, 255, 255)" data-rect="400,300,200,40">Buy</p></div>`;
    expect(analyze(embedShell(fullCanvas) + overlay).hasDom).toBe(false);
  });

  it("Unity template with footer has DOM", () => {
    const template = `
      <div id="unity-container" data-rect="32,32,960,700">
        <canvas id="unity-canvas" width="960" height="600" data-rect="32,32,960,600"></canvas>
        <div id="unity-footer" data-rect="32,632,960,38">
          <div id="unity-logo-title-footer" style="background-image: url(logo.png)" data-rect="32,632,102,38"></div>
          <div id="unity-build-title" style="color: rgb(255, 255, 255)" data-rect="800,640,150,20">My Game</div>
        </div>
      </div>`;
    const { canvases, hasDom } = analyze(template);
    expect(canvases).toHaveLength(1);
    expect(hasDom).toBe(true);
  });

  it("canvas plus a DOM HUD has DOM", () => {
    const hud = `<div id="hud" style="color: rgb(255, 255, 255)" data-rect="16,16,200,32">Score 1,200</div>`;
    expect(analyze(embedShell(fullCanvas + hud)).hasDom).toBe(true);
  });

  it("text inside a canvas wrapper counts as DOM", () => {
    const target = `Loading…${fullCanvas}`;
    expect(analyze(embedShell(target)).hasDom).toBe(true);
  });

  it("two canvases with no other DOM record two tracks without DOM", () => {
    const minimap = `<canvas id="minimap" width="256" height="256" data-rect="24,488,256,256"></canvas>`;
    const { canvases, hasDom } = analyze(embedShell(fullCanvas + minimap));
    expect(canvases.map((c) => c.canvas.id)).toEqual(["game", "minimap"]);
    expect(hasDom).toBe(false);
  });

  it("a canvas that leaves the page background visible has DOM", () => {
    const small = `<canvas id="game" width="640" height="480" data-rect="192,144,640,480"></canvas>`;
    expect(analyze(embedShell(small)).hasDom).toBe(true);
  });
});

describe("findCaptureCanvases", () => {
  it("skips hidden, transparent, empty and offscreen canvases", () => {
    const { canvases } = analyze(`
      ${fullCanvas}
      <canvas id="hidden" width="10" height="10" style="visibility: hidden" data-rect="0,0,10,10"></canvas>
      <div style="opacity: 0"><canvas id="faded" width="10" height="10" data-rect="0,0,10,10"></canvas></div>
      <canvas id="empty" width="0" height="10" data-rect="0,0,10,10"></canvas>
      <canvas id="offscreen" width="10" height="10" data-rect="2000,0,10,10"></canvas>
      <canvas id="detached" width="10" height="10"></canvas>`);
    expect(canvases.map((c) => c.canvas.id)).toEqual(["game"]);
  });

  it("orders by visible area and caps the track count", () => {
    const many = Array.from(
      { length: MAX_TRACKS + 2 },
      (_, i) =>
        `<canvas id="c${i}" width="10" height="10" data-rect="0,${i * 20},${10 + i},10"></canvas>`
    ).join("");
    const { canvases } = analyze(many);
    expect(canvases).toHaveLength(MAX_TRACKS);
    expect(canvases[0].canvas.id).toBe(`c${MAX_TRACKS + 1}`);
  });
});

describe("isTransferredCanvas", () => {
  it("is false for a canvas that is not a placeholder", () => {
    expect(isTransferredCanvas(document.createElement("canvas"))).toBe(false);
  });

  it("is true when getContext throws InvalidStateError", () => {
    const placeholder = document.createElement("canvas");
    placeholder.getContext = () => {
      throw new DOMException("transferred", "InvalidStateError");
    };
    expect(isTransferredCanvas(placeholder)).toBe(true);
  });

  it("rethrows unexpected errors", () => {
    const broken = document.createElement("canvas");
    broken.getContext = () => {
      throw new TypeError("boom");
    };
    expect(() => isTransferredCanvas(broken)).toThrow(TypeError);
  });
});
