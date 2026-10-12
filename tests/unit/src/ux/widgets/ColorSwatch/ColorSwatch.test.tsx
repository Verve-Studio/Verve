import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ColorSwatch } from "@/ux/widgets/ColorSwatch/ColorSwatch";

beforeEach(() => {
  // The embedded picker sizes its canvases with a ResizeObserver.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(cleanup);

describe("ColorSwatch", () => {
  it("shows the colour and toggles a picker popup on click", () => {
    render(<ColorSwatch value="#336699" onChange={vi.fn()} title="Grid colour" />);
    const btn = screen.getByRole("button", { name: "Grid colour" });
    expect(btn.style.background).toBe("rgb(51, 102, 153)");
    const popups = () => document.querySelectorAll("canvas").length > 0 ? 1 : 0;
    const before = popups();
    fireEvent.click(btn);
    expect(popups()).toBe(before + 1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(popups()).toBe(before);
  });

  it("an outside pointerdown closes the popup; one on the swatch doesn't", () => {
    render(<ColorSwatch value="#000000" onChange={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Pick color" });
    const popups = () => document.querySelectorAll("canvas").length > 0 ? 1 : 0;
    fireEvent.click(btn);
    const open = popups();
    fireEvent.pointerDown(btn);
    expect(popups()).toBe(open);
    fireEvent.pointerDown(document.body);
    expect(popups()).toBe(open - 1);
  });
});
