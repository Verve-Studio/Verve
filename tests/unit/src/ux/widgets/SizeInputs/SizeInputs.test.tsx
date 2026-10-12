import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SizeInputs, type SizeInputsProps } from "@/ux/widgets/SizeInputs/SizeInputs";

afterEach(cleanup);

function setup(props: Partial<SizeInputsProps> = {}) {
  const onWidthChange = vi.fn();
  const onHeightChange = vi.fn();
  const onConstrainChange = vi.fn();
  render(
    <SizeInputs
      width={200}
      height={100}
      constrain={true}
      originWidth={200}
      originHeight={100}
      onWidthChange={onWidthChange}
      onHeightChange={onHeightChange}
      onConstrainChange={onConstrainChange}
      {...props}
    />,
  );
  const [width, height] = screen.getAllByRole("textbox") as HTMLInputElement[];
  const enter = (input: HTMLInputElement, text: string) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
  };
  return { width, height, enter, onWidthChange, onHeightChange, onConstrainChange };
}

describe("SizeInputs", () => {
  it("shows the aspect ratio of the original size", () => {
    setup({ originWidth: 1920, originHeight: 1080 });
    expect(screen.getByText("(1.778)")).toBeTruthy();
  });

  it("shows a dash when the original size is degenerate", () => {
    setup({ originWidth: 0, originHeight: 100 });
    expect(screen.getByText("(—)")).toBeTruthy();
  });

  it("with constrain on, a width edit derives the height from the original ratio", () => {
    const { width, enter, onWidthChange, onHeightChange } = setup();
    enter(width, "300");
    expect(onWidthChange).toHaveBeenCalledWith(300);
    expect(onHeightChange).toHaveBeenCalledWith(150);
  });

  it("with constrain on, a height edit derives the width (rounded)", () => {
    const { height, enter, onWidthChange, onHeightChange } = setup({ originWidth: 3, originHeight: 2 });
    enter(height, "7");
    expect(onHeightChange).toHaveBeenCalledWith(7);
    expect(onWidthChange).toHaveBeenCalledWith(11); // 10.5 → 11
  });

  it("never derives a side smaller than min", () => {
    const { width, enter, onHeightChange } = setup({ originWidth: 1000, originHeight: 1 });
    enter(width, "10");
    expect(onHeightChange).toHaveBeenCalledWith(1);
  });

  it("with constrain off, sides change independently", () => {
    const { width, enter, onWidthChange, onHeightChange } = setup({ constrain: false });
    enter(width, "321");
    expect(onWidthChange).toHaveBeenCalledWith(321);
    expect(onHeightChange).not.toHaveBeenCalled();
  });

  it("clamps typed values to [min, max]", () => {
    const { width, enter, onWidthChange } = setup({ constrain: false, min: 4, max: 512 });
    enter(width, "9999");
    expect(onWidthChange).toHaveBeenLastCalledWith(512);
    enter(width, "0");
    expect(onWidthChange).toHaveBeenLastCalledWith(4);
  });

  it("turning constrain on snaps the height to the current width", () => {
    const { onConstrainChange, onHeightChange } = setup({ constrain: false, width: 400, height: 37 });
    fireEvent.click(screen.getByRole("checkbox", { name: /Constrain/ }));
    expect(onConstrainChange).toHaveBeenCalledWith(true);
    expect(onHeightChange).toHaveBeenCalledWith(200);
  });

  it("turning constrain off leaves the sizes alone", () => {
    const { onConstrainChange, onHeightChange, onWidthChange } = setup({ constrain: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /Constrain/ }));
    expect(onConstrainChange).toHaveBeenCalledWith(false);
    expect(onHeightChange).not.toHaveBeenCalled();
    expect(onWidthChange).not.toHaveBeenCalled();
  });

  it("never derives a side larger than max", () => {
    const { width, enter, onHeightChange } = setup({ originWidth: 100, originHeight: 400, width: 100, height: 400 });
    enter(width, "4000");
    for (const [h] of onHeightChange.mock.calls) expect(h).toBeLessThanOrEqual(8192);
  });

  it("shrinks the edited side so the ratio holds when the derived side hits max", () => {
    const { width, height, enter, onWidthChange, onHeightChange } = setup({
      originWidth: 100,
      originHeight: 400,
      width: 100,
      height: 400,
    });
    enter(width, "4000");
    expect(onWidthChange).toHaveBeenLastCalledWith(2048);
    expect(onHeightChange).toHaveBeenLastCalledWith(8192);
    enter(height, "8192");
    expect(onWidthChange).toHaveBeenLastCalledWith(2048);
  });
});
