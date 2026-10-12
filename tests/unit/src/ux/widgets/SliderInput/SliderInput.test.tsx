import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SliderInput } from "@/ux/widgets/SliderInput/SliderInput";

afterEach(cleanup);

function setup(props: Partial<React.ComponentProps<typeof SliderInput>> = {}) {
  const onChange = vi.fn();
  const utils = render(<SliderInput value={50} min={0} max={100} onChange={onChange} {...props} />);
  const input = screen.getByRole("textbox", { name: `value ${props.min ?? 0}–${props.max ?? 100}` }) as HTMLInputElement;
  const type = (text: string) => fireEvent.change(input, { target: { value: text } });
  return { onChange, input, type, ...utils };
}

const slider = () => document.querySelector<HTMLInputElement>("input[type=range]");

describe("SliderInput", () => {
  it("shows the value and an optional suffix", () => {
    setup({ suffix: "px" });
    expect(screen.getByDisplayValue("50")).toBeTruthy();
    expect(screen.getByText("px")).toBeTruthy();
  });

  it("commits typed text on Enter", () => {
    const { onChange, input, type } = setup();
    type("73");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(73);
  });

  it("commits on blur", () => {
    const { onChange, input, type } = setup();
    type("12");
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(12);
  });

  it.each([
    ["150", 100],
    ["-20", 0],
    ["1e9", 100],
  ])("clamps %s to the range (%d)", (text, expected) => {
    const { onChange, input, type } = setup();
    type(text);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(expected);
    expect(input.value).toBe(String(expected));
  });

  it("rounds to the step for steps of 1 or more", () => {
    const { onChange, input, type } = setup({ step: 5 });
    type("23");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(25);
  });

  it("keeps fractional values for fractional steps", () => {
    const { onChange, input, type } = setup({ step: 0.1, min: 0, max: 1, value: 0.5 });
    type("0.37");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(0.37);
  });

  it("reverts non-numeric text without calling onChange", () => {
    const { onChange, input, type } = setup();
    type("abc");
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("50");
  });

  it("Escape discards the edit", () => {
    const { onChange, input, type } = setup();
    fireEvent.focus(input);
    type("99");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("50");
    expect(slider()).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("follows external value changes", () => {
    const { rerender, onChange } = setup();
    rerender(<SliderInput value={8} min={0} max={100} onChange={onChange} />);
    expect(screen.getByDisplayValue("8")).toBeTruthy();
  });

  it("opens a range slider on focus that reports its value", () => {
    const { onChange, input } = setup({ step: 2 });
    fireEvent.focus(input);
    const range = slider()!;
    expect(range).not.toBeNull();
    expect(range.min).toBe("0");
    expect(range.max).toBe("100");
    expect(range.step).toBe("2");
    fireEvent.change(range, { target: { value: "64" } });
    expect(onChange).toHaveBeenCalledWith(64);
    expect(input.value).toBe("64");
  });

  it("closes the slider on an outside mousedown but not on one inside it", () => {
    const { input } = setup();
    fireEvent.focus(input);
    fireEvent.mouseDown(slider()!);
    expect(slider()).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(slider()).toBeNull();
  });

  it("is disabled and never opens the slider when disabled", () => {
    const { input } = setup({ disabled: true });
    expect(input.disabled).toBe(true);
    fireEvent.focus(input);
    expect(slider()).toBeNull();
  });
});
