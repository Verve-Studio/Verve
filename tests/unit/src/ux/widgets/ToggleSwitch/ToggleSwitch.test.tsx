import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToggleSwitch } from "@/ux/widgets/ToggleSwitch/ToggleSwitch";
import { DialogButton } from "@/ux/widgets/DialogButton/DialogButton";

afterEach(cleanup);

describe("ToggleSwitch", () => {
  it("reflects `checked` and reports the toggled value", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ToggleSwitch checked={false} onChange={onChange} title="Snap" />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<ToggleSwitch checked onChange={onChange} />);
    fireEvent.click(box);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("clicking the label toggles too", () => {
    const onChange = vi.fn();
    render(<ToggleSwitch checked={false} onChange={onChange} title="Snap" />);
    fireEvent.click(screen.getByTitle("Snap"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  // (jsdom still runs a disabled checkbox's activation on a synthetic
  // click, so only the disabled state is asserted here.)
  it("disables the checkbox", () => {
    render(<ToggleSwitch checked={false} onChange={vi.fn()} disabled />);
    expect((screen.getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
  });
});

describe("DialogButton", () => {
  it("is a non-submitting button by default that fires onClick", () => {
    const onClick = vi.fn();
    render(<DialogButton onClick={onClick}>OK</DialogButton>);
    const btn = screen.getByRole("button", { name: "OK" }) as HTMLButtonElement;
    expect(btn.type).toBe("button");
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("passes accessibility props and ignores clicks when disabled", () => {
    const onClick = vi.fn();
    render(
      <DialogButton onClick={onClick} disabled aria-label="Bold" aria-pressed title="Bold text">
        B
      </DialogButton>,
    );
    const btn = screen.getByRole("button", { name: "Bold" });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.title).toBe("Bold text");
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("applies width / alignment as block layout", () => {
    render(
      <DialogButton width={120} align="right">
        Go
      </DialogButton>,
    );
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn.style.width).toBe("120px");
    expect(btn.style.display).toBe("block");
    expect(btn.style.marginLeft).toBe("auto");
  });
});
