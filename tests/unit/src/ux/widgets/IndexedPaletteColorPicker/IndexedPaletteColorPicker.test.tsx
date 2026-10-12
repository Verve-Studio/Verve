import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IndexedPaletteColorPicker } from "@/ux/widgets/IndexedPaletteColorPicker/IndexedPaletteColorPicker";

afterEach(cleanup);

const PALETTE = [
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 128, b: 255, a: 255 },
  { r: 16, g: 16, b: 16, a: 0 },
];

function setup(activeIndex = 1, withAdd = true) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const onAddColor = vi.fn();
  render(
    <IndexedPaletteColorPicker
      palette={PALETTE}
      activeIndex={activeIndex}
      anchorPos={{ x: 10, y: 10 }}
      onSelect={onSelect}
      onClose={onClose}
      onAddColor={withAdd ? onAddColor : undefined}
    />,
  );
  return { onSelect, onClose, onAddColor };
}

describe("IndexedPaletteColorPicker", () => {
  it("shows one cell per palette entry, labelled with index and hex", () => {
    setup();
    expect(screen.getByTitle("idx 0 #ff0000")).toBeTruthy();
    expect(screen.getByTitle("idx 1 #0080ff")).toBeTruthy();
    expect(screen.getByTitle("idx 2 #101010")).toBeTruthy();
  });

  it("the footer shows the active entry, or the hovered one", () => {
    setup(1);
    expect(screen.getByText(/idx 1.*#0080FF/)).toBeTruthy();
    fireEvent.pointerEnter(screen.getByTitle("idx 0 #ff0000"));
    expect(screen.getByText(/idx 0.*#FF0000/)).toBeTruthy();
    fireEvent.pointerLeave(screen.getByTitle("idx 0 #ff0000"));
    expect(screen.getByText(/idx 1.*#0080FF/)).toBeTruthy();
  });

  it("shows a dash without an active entry", () => {
    setup(-1);
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("selecting a cell reports index + colour and closes", () => {
    const { onSelect, onClose } = setup();
    fireEvent.click(screen.getByTitle("idx 2 #101010"));
    expect(onSelect).toHaveBeenCalledWith(2, PALETTE[2]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on a pointerdown outside, not inside", () => {
    const { onClose } = setup();
    fireEvent.pointerDown(screen.getByTitle("idx 0 #ff0000"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("the + button closes and asks to add a colour; it's absent without a handler", () => {
    const { onAddColor, onClose } = setup();
    fireEvent.click(screen.getByTitle("Add new color to palette"));
    expect(onClose).toHaveBeenCalled();
    expect(onAddColor).toHaveBeenCalled();
    cleanup();
    setup(0, false);
    expect(screen.queryByTitle("Add new color to palette")).toBeNull();
  });
});
