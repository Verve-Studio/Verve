import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { preferencesStore } from "@/core/store/preferencesStore";
import { PreferencesDialog } from "@/ux/modals/PreferencesDialog/PreferencesDialog";

const GB = 1024 * 1024 * 1024;

let api: {
  savePreferences: ReturnType<typeof vi.fn>;
  getSystemTotalMemoryBytes: ReturnType<typeof vi.fn>;
  getFileAssocState: ReturnType<typeof vi.fn>;
  applyFileAssoc: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = {
    savePreferences: vi.fn(async () => {}),
    getSystemTotalMemoryBytes: vi.fn(async () => 16 * GB),
    getFileAssocState: vi.fn(async () => ({
      platform: "win32",
      supported: [{ ext: "png" }, { ext: "jpg" }, { ext: "verve" }],
      registered: ["verve"],
    })),
    applyFileAssoc: vi.fn(async () => ({ success: true })),
  };
  vi.stubGlobal("api", api);
  preferencesStore.set({
    theme: "dark",
    historyMemoryBytes: 4 * GB,
    bufferMemoryBytes: 8 * GB,
    bufferMemoryMaxOut: false,
    unifiedMemory: false,
  });
});
afterEach(cleanup);

function setup() {
  const onClose = vi.fn();
  render(<PreferencesDialog open onClose={onClose} />);
  const section = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
  return { onClose, section };
}

describe("PreferencesDialog", () => {
  it("opens on Appearance with the current theme selected and changes it", () => {
    setup();
    const dark = screen.getByRole("radio", { name: /Dark/ }) as HTMLInputElement;
    expect(dark.checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
    expect(preferencesStore.get().theme).toBe("light");
    expect(api.savePreferences).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "light" }));
    expect((screen.getByRole("radio", { name: /Light/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("Close and Escape call onClose", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe("Memory", () => {
    it("the history limit slider writes bytes to the preferences", () => {
      const { section } = setup();
      section("Memory");
      fireEvent.change(screen.getByLabelText("History memory limit"), { target: { value: "2.5" } });
      expect(preferencesStore.get().historyMemoryBytes).toBe(2.5 * GB);
    });

    it("buffer memory is capped at installed RAM and disabled by Max Out", async () => {
      api.getSystemTotalMemoryBytes.mockResolvedValue(15.7 * GB);
      const { section } = setup();
      section("Memory");
      const slider = screen.getByLabelText("Buffer memory limit") as HTMLInputElement;
      await waitFor(() => expect(slider.max).toBe("15.5"));
      fireEvent.change(slider, { target: { value: "6" } });
      expect(preferencesStore.get().bufferMemoryBytes).toBe(6 * GB);
      fireEvent.click(screen.getByRole("checkbox", { name: "Max Out" }));
      expect(preferencesStore.get().bufferMemoryMaxOut).toBe(true);
      expect(slider.disabled).toBe(true);
    });

    it("the unified-memory checkbox toggles the preference", () => {
      const { section } = setup();
      section("Memory");
      fireEvent.click(screen.getByRole("checkbox", { name: /unified memory/ }));
      expect(preferencesStore.get().unifiedMemory).toBe(true);
    });

    it("keeps typed history limits within 0.5–64 GB", () => {
      const { section } = setup();
      section("Memory");
      const [historyNumber] = screen.getAllByRole("spinbutton");
      fireEvent.change(historyNumber, { target: { value: "" } });
      expect(preferencesStore.get().historyMemoryBytes).toBeGreaterThanOrEqual(0.5 * GB);
      fireEvent.change(historyNumber, { target: { value: "-3" } });
      expect(preferencesStore.get().historyMemoryBytes).toBeGreaterThanOrEqual(0.5 * GB);
      fireEvent.change(historyNumber, { target: { value: "500" } });
      expect(preferencesStore.get().historyMemoryBytes).toBe(64 * GB);
    });

    it("keeps typed buffer limits within 0.5 GB and installed RAM", async () => {
      const { section } = setup();
      section("Memory");
      const slider = screen.getByLabelText("Buffer memory limit") as HTMLInputElement;
      await waitFor(() => expect(slider.max).toBe("16"));
      const [, bufferNumber] = screen.getAllByRole("spinbutton");
      fireEvent.change(bufferNumber, { target: { value: "" } });
      expect(preferencesStore.get().bufferMemoryBytes).toBe(8 * GB);
      fireEvent.change(bufferNumber, { target: { value: "0" } });
      expect(preferencesStore.get().bufferMemoryBytes).toBe(0.5 * GB);
      fireEvent.change(bufferNumber, { target: { value: "100" } });
      expect(preferencesStore.get().bufferMemoryBytes).toBe(16 * GB);
    });
  });

  describe("File Associations", () => {
    const openSection = async () => {
      const utils = setup();
      utils.section("File Associations");
      await screen.findByText("PNG Image (.png)");
      return utils;
    };

    it("lists supported and registered types from the main process", async () => {
      await openSection();
      expect(screen.getByText("Verve Document (.verve)")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add selected to registered" })).toHaveProperty("disabled", true);
    });

    it("moves selected types and applies the registered list", async () => {
      await openSection();
      fireEvent.mouseDown(screen.getByText("PNG Image (.png)"));
      fireEvent.click(screen.getByRole("button", { name: "Add selected to registered" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await screen.findByText("File associations updated successfully.");
      expect(api.applyFileAssoc).toHaveBeenCalledWith(["verve", "png"]);
    });

    it("Add all / Remove all move everything", async () => {
      await openSection();
      fireEvent.click(screen.getByRole("button", { name: "Add all to registered" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(api.applyFileAssoc).toHaveBeenCalledWith(["verve", "png", "jpg"]));
      fireEvent.click(screen.getByRole("button", { name: "Remove all from registered" }));
      fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(api.applyFileAssoc).toHaveBeenLastCalledWith([]));
    });

    it("shows the error when applying fails", async () => {
      api.applyFileAssoc.mockResolvedValue({ success: false, error: "Access denied" });
      await openSection();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
      });
      expect(await screen.findByText("Access denied")).toBeTruthy();
    });

    it("hides the move buttons on macOS", async () => {
      api.getFileAssocState.mockResolvedValue({
        platform: "darwin",
        supported: [{ ext: "png" }],
        registered: [],
      });
      await openSection();
      expect(screen.queryByRole("button", { name: "Add all to registered" })).toBeNull();
      expect(screen.getByText(/Launch Services/)).toBeTruthy();
    });
  });
});
