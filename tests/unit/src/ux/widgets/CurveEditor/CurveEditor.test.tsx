import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CurveEditor } from "@/ux/widgets/CurveEditor/CurveEditor";

// jsdom has no layout: the editor surface is 200×100 px.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON() {} }) as DOMRect,
  );
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});
afterEach(cleanup);

describe("CurveEditor", () => {
  const PTS = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0.5 },
    { x: 1, y: 1 },
  ];
  function setupEditor(points = PTS) {
    const onChange = vi.fn();
    const utils = render(<CurveEditor points={points} onChange={onChange} width={200} height={100} xLabel="pressure" yLabel="size" />);
    const surface = utils.container.querySelector("svg")!.parentElement as HTMLElement;
    return { onChange, surface, ...utils };
  }

  it("clicking empty space inserts a point in x order", () => {
    const { surface, onChange } = setupEditor();
    fireEvent.pointerDown(surface, { button: 0, clientX: 50, clientY: 25 });
    expect(onChange).toHaveBeenCalledWith([
      { x: 0, y: 0 },
      { x: 0.25, y: 0.75 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]);
  });

  it("dragging an interior point can't pass its neighbours; endpoints keep their x", () => {
    const { surface, onChange, rerender } = setupEditor();
    fireEvent.pointerDown(surface, { button: 0, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(surface, { clientX: 250, clientY: 0 });
    expect(onChange).toHaveBeenLastCalledWith([{ x: 0, y: 0 }, { x: 0.999, y: 1 }, { x: 1, y: 1 }]);
    fireEvent.pointerUp(surface);

    rerender(<CurveEditor points={PTS} onChange={onChange} width={200} height={100} />);
    fireEvent.pointerDown(surface, { button: 0, clientX: 200, clientY: 0 });
    fireEvent.pointerMove(surface, { clientX: 120, clientY: 80 });
    const last = onChange.mock.calls.at(-1)![0] as { x: number; y: number }[];
    expect(last[2].x).toBe(1);
    expect(last[2].y).toBeCloseTo(0.2);
  });

  it("right-click deletes an interior point but not an endpoint", () => {
    const { surface, onChange } = setupEditor();
    fireEvent.pointerDown(surface, { button: 2, clientX: 0, clientY: 100 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(surface, { button: 2, clientX: 100, clientY: 50 });
    expect(onChange).toHaveBeenCalledWith([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it("shows axis labels", () => {
    setupEditor();
    expect(screen.getByText("pressure")).toBeTruthy();
    expect(screen.getByText("size")).toBeTruthy();
  });
});
