import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CurvesControlPoint, CurvesVisualAids } from "@/types";
import { CurvesGraph } from "@/ux/widgets/CurvesGraph/CurvesGraph";

// The graph is 216 px square; jsdom has no layout, so give every element
// that size.
const rect = { left: 0, top: 0, width: 216, height: 216 };
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: 0, y: 0, toJSON() {} }) as DOMRect,
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  // Run the drag's rAF-batched move immediately.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
});
afterEach(cleanup);

const AIDS: CurvesVisualAids = { gridDensity: "4x4", showClippingIndicators: true, showReadout: false };
const IDENTITY: CurvesControlPoint[] = [
  { id: "lo", x: 0, y: 0 },
  { id: "hi", x: 255, y: 255 },
];
const WITH_MID: CurvesControlPoint[] = [IDENTITY[0], { id: "mid", x: 128, y: 160 }, IDENTITY[1]];

function setupGraph(points = WITH_MID, extra: Partial<React.ComponentProps<typeof CurvesGraph>> = {}) {
  const cb = {
    onAddPoint: vi.fn(),
    onMovePoint: vi.fn(),
    onSelectPoint: vi.fn(),
    onDeletePoint: vi.fn(),
    onNudgePoint: vi.fn(),
    onHoverChange: vi.fn(),
  };
  const utils = render(
    <CurvesGraph
      channel="rgb"
      points={points}
      histogram={null}
      visualAids={AIDS}
      selectedPointId={null}
      {...cb}
      {...extra}
    />,
  );
  const stage = utils.container.querySelector("[data-channel]") as HTMLElement;
  const point = (id: string) => utils.container.querySelector(`[data-point-id="${id}"]`) as Element;
  return { ...cb, ...utils, stage, point };
}

describe("CurvesGraph", () => {
  it("clicking empty graph space adds a point at the matching input / output", () => {
    const { stage, onAddPoint } = setupGraph();
    fireEvent.pointerDown(stage, { button: 0, clientX: 54, clientY: 54 });
    // x 54/216 → 64; y 54 from the top → 191
    expect(onAddPoint).toHaveBeenCalledWith(64, 191);
  });

  it("ignores non-primary buttons", () => {
    const { stage, onAddPoint } = setupGraph();
    fireEvent.pointerDown(stage, { button: 2, clientX: 10, clientY: 10 });
    expect(onAddPoint).not.toHaveBeenCalled();
  });

  it("dragging a point selects it and moves it", () => {
    const { stage, point, onSelectPoint, onMovePoint, onAddPoint } = setupGraph();
    fireEvent.pointerDown(point("mid"), { button: 0, clientX: 108, clientY: 81 });
    expect(onSelectPoint).toHaveBeenCalledWith("mid");
    expect(onAddPoint).not.toHaveBeenCalled();
    fireEvent.pointerMove(stage, { buttons: 1, clientX: 162, clientY: 0 });
    expect(onMovePoint).toHaveBeenLastCalledWith("mid", 191, 255);
    fireEvent.pointerUp(stage);
    fireEvent.pointerMove(stage, { buttons: 0, clientX: 0, clientY: 0 });
    expect(onMovePoint).toHaveBeenCalledTimes(1);
  });

  it("endpoints only move vertically", () => {
    const { stage, point, onMovePoint } = setupGraph();
    fireEvent.pointerDown(point("lo"), { button: 0, clientX: 0, clientY: 216 });
    fireEvent.pointerMove(stage, { buttons: 1, clientX: 100, clientY: 108 });
    expect(onMovePoint).toHaveBeenLastCalledWith("lo", 0, 128);
  });

  it("shift-drag locks to the dominant axis", () => {
    const { stage, point, onMovePoint } = setupGraph();
    fireEvent.pointerDown(point("mid"), { button: 0, clientX: 108, clientY: 81 });
    fireEvent.pointerMove(stage, { buttons: 1, shiftKey: true, clientX: 150, clientY: 85 });
    // Horizontal lock: output stays at the point's y.
    expect(onMovePoint).toHaveBeenLastCalledWith("mid", 177, 160);
  });

  it("a silent pen lift ends the drag", () => {
    const { stage, point, onMovePoint } = setupGraph();
    fireEvent.pointerDown(point("mid"), { button: 0, clientX: 108, clientY: 81 });
    fireEvent.pointerMove(stage, { buttons: 0, clientX: 150, clientY: 85 });
    fireEvent.pointerMove(stage, { buttons: 1, clientX: 150, clientY: 85 });
    expect(onMovePoint).not.toHaveBeenCalled();
  });

  it("double-click deletes interior points but never endpoints", () => {
    const { point, onDeletePoint } = setupGraph();
    fireEvent.doubleClick(point("hi"));
    expect(onDeletePoint).not.toHaveBeenCalled();
    fireEvent.doubleClick(point("mid"));
    expect(onDeletePoint).toHaveBeenCalledWith("mid");
  });

  it("arrow keys nudge the selected point (×10 with Shift); Delete removes it", () => {
    const { container, onNudgePoint, onDeletePoint } = setupGraph(WITH_MID, { selectedPointId: "mid" });
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(wrapper, { key: "ArrowRight" });
    fireEvent.keyDown(wrapper, { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(wrapper, { key: "ArrowDown" });
    fireEvent.keyDown(wrapper, { key: "ArrowLeft", shiftKey: true });
    expect(onNudgePoint.mock.calls).toEqual([
      ["mid", 1, 0],
      ["mid", 0, 10],
      ["mid", 0, -1],
      ["mid", -10, 0],
    ]);
    fireEvent.keyDown(wrapper, { key: "Delete" });
    expect(onDeletePoint).toHaveBeenCalledWith("mid");
  });

  it("Delete leaves a selected endpoint alone; keys do nothing without a selection", () => {
    const a = setupGraph(WITH_MID, { selectedPointId: "lo" });
    fireEvent.keyDown(a.container.firstElementChild!, { key: "Delete" });
    expect(a.onDeletePoint).not.toHaveBeenCalled();
    cleanup();
    const b = setupGraph(WITH_MID);
    fireEvent.keyDown(b.container.firstElementChild!, { key: "ArrowUp" });
    expect(b.onNudgePoint).not.toHaveBeenCalled();
  });

  it("shows the identity hint only for the untouched diagonal", () => {
    setupGraph(IDENTITY);
    expect(screen.getByText(/Linear identity/)).toBeTruthy();
    cleanup();
    setupGraph(WITH_MID);
    expect(screen.queryByText(/Linear identity/)).toBeNull();
  });

  it("reports the hovered input / output when the readout is on", () => {
    const { stage, onHoverChange } = setupGraph(WITH_MID, { visualAids: { ...AIDS, showReadout: true } });
    fireEvent.pointerMove(stage, { buttons: 0, clientX: 216, clientY: 0 });
    expect(onHoverChange).toHaveBeenCalledWith(255, 255);
  });
});
