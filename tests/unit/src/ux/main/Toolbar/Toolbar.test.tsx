import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import "@/core/tools";
import { toolRegistry } from "@/core/tools/toolRegistry";
import type { ITool } from "@/core/tools";
import type { LayerState } from "@/types";
import { Toolbar } from "@/ux/main/Toolbar/Toolbar";
import { pixel, renderWithAppStore, seedLayers, mask } from "@tests/fakes/uxAppStore";

afterEach(cleanup);

const placed = (): ITool[] => toolRegistry.all().filter((t) => t.placement !== null);

/** The toolbar button for a tool (standard buttons are labelled
 *  "Label  (Shortcut)"; custom ones start with the label). */
function buttonFor(tool: ITool): HTMLElement {
  const nav = screen.getByRole("navigation", { name: "Drawing tools" });
  const label = tool.shortcut ? `${tool.label}  (${tool.shortcut})` : tool.label;
  const exact = within(nav).queryByRole("button", { name: label });
  if (exact) return exact;
  return within(nav).getAllByRole("button", { name: new RegExp(`^${tool.label}\\b`) })[0];
}

const textLayer = (id: string): LayerState =>
  ({ ...pixel(id), type: "text" }) as unknown as LayerState;

describe("Toolbar", () => {
  it("renders a button for every tool with a toolbar placement, in registry order", () => {
    renderWithAppStore(<Toolbar activeTool="pencil" />);
    const tools = placed();
    expect(tools.length).toBeGreaterThan(10);
    for (const t of tools) expect(buttonFor(t)).toBeTruthy();

    const order = toolRegistry
      .toolbarGroups()
      .flat(2)
      .filter((t): t is ITool => t !== null && !t.customRender)
      .map((t) => (t.shortcut ? `${t.label}  (${t.shortcut})` : t.label));
    const nav = screen.getByRole("navigation", { name: "Drawing tools" });
    const rendered = within(nav)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"))
      .filter((l): l is string => order.includes(l ?? ""));
    expect(rendered).toEqual(order);
  });

  it("does not render tools without a placement", () => {
    renderWithAppStore(<Toolbar />);
    const unplaced = toolRegistry.all().filter((t) => t.placement === null);
    for (const t of unplaced) {
      const label = t.shortcut ? `${t.label}  (${t.shortcut})` : t.label;
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("marks only the active tool as pressed", () => {
    renderWithAppStore(<Toolbar activeTool="eraser" />);
    const eraser = toolRegistry.require("eraser");
    expect(buttonFor(eraser).getAttribute("aria-pressed")).toBe("true");
    expect(buttonFor(toolRegistry.require("pencil")).getAttribute("aria-pressed")).toBe("false");
  });

  it("enables every tool on a pixel layer in an rgba8 document and reports clicks", () => {
    const onToolChange = vi.fn();
    renderWithAppStore(<Toolbar onToolChange={onToolChange} />);
    for (const t of placed()) expect((buttonFor(t) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(buttonFor(toolRegistry.require("brush")));
    expect(onToolChange).toHaveBeenCalledWith("brush");
  });

  it("treats a layer mask as a pixel target", () => {
    renderWithAppStore(<Toolbar />, seedLayers([pixel("a"), mask("m", "a")], "m"));
    for (const t of placed().filter((t) => t.pixelOnly)) {
      expect((buttonFor(t) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("disables pixel-only tools when the active layer isn't a pixel layer, and ignores clicks on them", () => {
    const onToolChange = vi.fn();
    renderWithAppStore(<Toolbar onToolChange={onToolChange} />, seedLayers([pixel("a"), textLayer("t")], "t"));
    const pixelOnly = placed().filter((t) => t.pixelOnly);
    expect(pixelOnly.length).toBeGreaterThan(0);
    for (const t of placed()) {
      expect((buttonFor(t) as HTMLButtonElement).disabled, t.id).toBe(!!t.pixelOnly);
    }
    fireEvent.click(buttonFor(pixelOnly[0]));
    expect(onToolChange).not.toHaveBeenCalled();
  });

  it("disables pixel-only tools when no layer is active", () => {
    renderWithAppStore(<Toolbar />, seedLayers([pixel("a")], null));
    for (const t of placed().filter((t) => t.pixelOnly)) {
      expect((buttonFor(t) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("disables indexed8-unsupported tools in indexed8 documents", () => {
    renderWithAppStore(<Toolbar />, [{ type: "SET_PIXEL_FORMAT", payload: "indexed8" }]);
    const unsupported = placed().filter((t) => t.indexed8Unsupported);
    expect(unsupported.length).toBeGreaterThan(0);
    for (const t of placed()) {
      expect((buttonFor(t) as HTMLButtonElement).disabled, t.id).toBe(!!t.indexed8Unsupported);
    }
  });

  it("swaps and resets the foreground / background colours", () => {
    const { store } = renderWithAppStore(<Toolbar />, [
      { type: "SET_PRIMARY_COLOR", payload: { r: 1, g: 0, b: 0, a: 1 } },
      { type: "SET_SECONDARY_COLOR", payload: { r: 0, g: 0, b: 1, a: 1 } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Swap foreground/background" }));
    expect(store.getState().primaryColor).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(store.getState().secondaryColor).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reset colors to default" }));
    expect(store.getState().primaryColor).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(store.getState().secondaryColor).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });

  it("shows the colours as CSS, clamping HDR values to 255", () => {
    renderWithAppStore(<Toolbar />, [
      { type: "SET_PRIMARY_COLOR", payload: { r: 4, g: 0.5, b: 0, a: 1 } },
    ]);
    const fg = screen.getByRole("button", { name: "Foreground color" });
    expect(fg.style.background).toBe("rgb(255, 128, 0)");
  });

  it("in indexed8 documents the colour wells open the palette picker and pick an entry", () => {
    const { store } = renderWithAppStore(<Toolbar />, [
      { type: "SET_PIXEL_FORMAT", payload: "indexed8" },
      {
        type: "SET_SWATCHES",
        payload: [
          { r: 0, g: 0, b: 0, a: 255 },
          { r: 255, g: 51, b: 0, a: 255 },
        ],
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Background color" }));
    fireEvent.click(screen.getByTitle("idx 1 #ff3300"));
    expect(store.getState().activePaletteIndex).toBe(1);
    expect(store.getState().secondaryColor).toEqual({ r: 1, g: 0.2, b: 0, a: 1 });
    expect(screen.queryByTitle("idx 1 #ff3300")).toBeNull();
  });
});
