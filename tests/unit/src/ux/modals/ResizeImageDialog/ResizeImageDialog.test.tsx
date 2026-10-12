import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ResizeImageDialog } from "@/ux/modals/ResizeImageDialog/ResizeImageDialog";
import { ResizeCanvasDialog } from "@/ux/modals/ResizeCanvasDialog/ResizeCanvasDialog";

afterEach(cleanup);

function fields() {
  const dialog = screen.getByRole("dialog");
  const [width, height] = within(dialog).getAllByRole("textbox") as HTMLInputElement[];
  /** Type a value and leave the field (blur commits it). */
  const set = (input: HTMLInputElement, v: string) => {
    fireEvent.change(input, { target: { value: v } });
    fireEvent.blur(input);
  };
  return { dialog, width, height, set };
}

describe("ResizeImageDialog", () => {
  const setup = (w = 400, h = 200) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <ResizeImageDialog open currentWidth={w} currentHeight={h} onConfirm={onConfirm} onCancel={onCancel} />,
    );
    return { onConfirm, onCancel, ...utils, ...fields() };
  };

  it("renders nothing when closed", () => {
    render(<ResizeImageDialog open={false} currentWidth={1} currentHeight={1} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("starts at the current size with constrain on and bilinear filtering", () => {
    const { onConfirm, width, height } = setup();
    expect(screen.getByText("Current: 400 × 200 px")).toBeTruthy();
    expect(width.value).toBe("400");
    expect(height.value).toBe("200");
    expect((screen.getByRole("checkbox", { name: /Constrain/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 400, height: 200, filter: "bilinear" });
  });

  it("keeps the aspect ratio when the width changes", () => {
    const { onConfirm, width, height, set } = setup();
    set(width, "1000");
    expect(height.value).toBe("500");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 1000, height: 500, filter: "bilinear" });
  });

  it("submits independent sizes and the chosen filter when constrain is off", () => {
    const { onConfirm, width, height, set } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Constrain/ }));
    set(width, "64");
    set(height, "48");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "nearest" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 64, height: 48, filter: "nearest" });
  });

  it("Enter confirms, Escape and Cancel cancel", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it("resets edits when it is reopened", () => {
    const { width, set, rerender, onConfirm, onCancel } = setup();
    set(width, "10");
    const props = { currentWidth: 400, currentHeight: 200, onConfirm, onCancel };
    rerender(<ResizeImageDialog open={false} {...props} />);
    rerender(<ResizeImageDialog open {...props} />);
    expect(fields().width.value).toBe("400");
  });

  it("Enter in a size field commits the typed value before confirming", () => {
    const { onConfirm, width } = setup();
    fireEvent.change(width, { target: { value: "1000" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(onConfirm).toHaveBeenLastCalledWith({ width: 1000, height: 500, filter: "bilinear" });
  });
});

describe("ResizeCanvasDialog", () => {
  const setup = (w = 300, h = 100) => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ResizeCanvasDialog open currentWidth={w} currentHeight={h} onConfirm={onConfirm} onCancel={onCancel} />);
    return { onConfirm, onCancel, ...fields() };
  };
  const anchor = (key: string) => screen.getByRole("button", { name: `Anchor ${key}` });

  it("starts unconstrained, centred, with no change", () => {
    const { onConfirm } = setup();
    expect((screen.getByRole("checkbox", { name: /Constrain/ }) as HTMLInputElement).checked).toBe(false);
    expect(anchor("1,1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("No change")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 300, height: 100, anchorCol: 1, anchorRow: 1 });
  });

  it("has a 3×3 anchor grid; picking a cell moves the anchor", () => {
    const { onConfirm } = setup();
    const grid = screen.getByRole("group", { name: "Anchor position" });
    expect(within(grid).getAllByRole("button")).toHaveLength(9);
    fireEvent.click(anchor("2,0"));
    expect(anchor("2,0").getAttribute("aria-pressed")).toBe("true");
    expect(anchor("1,1").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 300, height: 100, anchorCol: 2, anchorRow: 0 });
  });

  it("shows the size delta and submits the new size", () => {
    const { onConfirm, width, height, set } = setup();
    set(width, "350");
    set(height, "80");
    expect(screen.getByText("+50px width, -20px height")).toBeTruthy();
    fireEvent.click(anchor("0,2"));
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onConfirm).toHaveBeenCalledWith({ width: 350, height: 80, anchorCol: 0, anchorRow: 2 });
  });

  it("constrain links the sides to the current ratio", () => {
    const { width, height, set } = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /Constrain/ }));
    set(width, "600");
    expect(height.value).toBe("200");
  });

  it("Enter in a size field commits the typed value before confirming", () => {
    const { onConfirm, width, height } = setup();
    fireEvent.change(width, { target: { value: "350" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenLastCalledWith({ width: 350, height: 100, anchorCol: 1, anchorRow: 1 });
    fireEvent.change(height, { target: { value: "90" } });
    fireEvent.keyDown(height, { key: "Enter" });
    expect(onConfirm).toHaveBeenLastCalledWith({ width: 350, height: 90, anchorCol: 1, anchorRow: 1 });
  });

  it("Enter confirms, Escape cancels", () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
