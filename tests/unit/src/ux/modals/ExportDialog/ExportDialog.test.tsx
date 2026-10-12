import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExportDialog, type ExportDialogProps } from "@/ux/modals/ExportDialog/ExportDialog";

afterEach(cleanup);

const LAYERS = [
  { id: "l1", name: "Sky" },
  { id: "l2", name: "Trees" },
];

function setup(props: Partial<ExportDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ExportDialog
      open
      documentWidth={1024}
      documentHeight={512}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  const path = screen.getByLabelText("File") as HTMLInputElement;
  const format = screen.getByLabelText("Format") as HTMLSelectElement;
  const set = (el: Element, value: string) => fireEvent.change(el, { target: { value } });
  const exportBtn = () => fireEvent.click(screen.getByRole("button", { name: "Export" }));
  const last = () => onConfirm.mock.calls.at(-1)![0];
  return { onConfirm, onCancel, path, format, set, exportBtn, last, ...utils };
}

describe("ExportDialog", () => {
  it("doesn't export without a file path", () => {
    const { onConfirm, exportBtn, path, set } = setup();
    exportBtn();
    set(path, "   ");
    exportBtn();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export" }).title).toBe("Choose a file path first");
  });

  it("exports PNG with default settings and a trimmed path", () => {
    const { exportBtn, path, set, last } = setup();
    set(path, "  C:/out/pic.png ");
    exportBtn();
    expect(last()).toEqual({
      filePath: "C:/out/pic.png",
      format: "png",
      jpegQuality: 92,
      jpegBackground: "#ffffff",
      webpQuality: 90,
      exrCompression: 0,
      exrHalfFloat: false,
      ddsCompression: "bc7",
      ddsMipLevels: 1,
      layerMode: "single",
      perLayerIds: undefined,
    });
  });

  it("switching format rewrites the file extension", () => {
    const { path, format, set } = setup();
    set(path, "/tmp/pic.png");
    set(format, "jpeg");
    expect(path.value).toBe("/tmp/pic.jpg");
    set(format, "tiff");
    expect(path.value).toBe("/tmp/pic.tiff");
    set(format, "psd");
    expect(path.value).toBe("/tmp/pic.psd");
  });

  it("JPEG quality is clamped to 1–100 and the background colour is validated on blur", () => {
    const { path, format, set, exportBtn, last } = setup();
    set(path, "/a.jpg");
    set(format, "jpeg");
    const [qualityNumber] = screen.getAllByRole("spinbutton");
    set(qualityNumber, "250");
    exportBtn();
    expect(last().jpegQuality).toBe(100);
    set(qualityNumber, "0");
    exportBtn();
    expect(last().jpegQuality).toBe(1);

    const hex = screen.getByLabelText("Background") as HTMLInputElement;
    set(hex, "#12ab34");
    fireEvent.blur(hex);
    exportBtn();
    expect(last().jpegBackground).toBe("#12ab34");
    set(hex, "red");
    fireEvent.blur(hex);
    expect(hex.value).toBe("#ffffff");
  });

  it("WebP quality comes from the WebP slider", () => {
    const { path, format, set, exportBtn, last } = setup();
    set(path, "/a.webp");
    set(format, "webp");
    set(screen.getByLabelText("Quality"), "40");
    exportBtn();
    expect(last()).toMatchObject({ format: "webp", webpQuality: 40 });
  });

  it("HDR formats are offered only for HDR documents", () => {
    setup();
    expect(screen.queryByRole("option", { name: "OpenEXR" })).toBeNull();
    cleanup();
    setup({ isHdrDocument: true });
    expect(screen.getByRole("option", { name: "OpenEXR" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Radiance HDR (.hdr)" })).toBeTruthy();
  });

  it("EXR options and multilayer default", () => {
    const { path, format, set, exportBtn, last } = setup({ isHdrDocument: true, exportableLayers: LAYERS });
    set(path, "/a.exr");
    set(format, "exr");
    set(screen.getByLabelText("Compression"), "3");
    fireEvent.click(screen.getByLabelText(/Half float/));
    exportBtn();
    expect(last()).toMatchObject({ format: "exr", exrCompression: 3, exrHalfFloat: true, layerMode: "multilayer" });
  });

  it("DDS mip levels are limited by the document size", () => {
    const { path, format, set, exportBtn, last } = setup({ documentWidth: 1024, documentHeight: 512 });
    set(path, "/a.dds");
    set(format, "dds");
    const mips = screen.getByLabelText("Mip levels") as HTMLSelectElement;
    // 1024×512 → 512×256 → 256×128: three levels with both sides ≥ 128.
    expect([...mips.options].map((o) => o.value)).toEqual(["1", "2", "3"]);
    expect(mips.options[2].textContent).toBe("3 (down to 256×128)");
    set(mips, "3");
    set(screen.getByLabelText("Compression"), "bc1");
    exportBtn();
    expect(last()).toMatchObject({ format: "dds", ddsCompression: "bc1", ddsMipLevels: 3, layerMode: "single" });
  });

  it("separate-file export submits the ticked layers", () => {
    const { path, set, exportBtn, last } = setup({ exportableLayers: LAYERS });
    set(path, "/a.png");
    const mode = screen.getByLabelText("Mode") as HTMLSelectElement;
    expect([...mode.options].map((o) => o.value)).toEqual(["single", "separate"]);
    set(mode, "separate");
    exportBtn();
    expect(last()).toMatchObject({ layerMode: "separate", perLayerIds: ["l1", "l2"] });
    fireEvent.click(screen.getByLabelText("Sky"));
    exportBtn();
    expect(last().perLayerIds).toEqual(["l2"]);
  });

  it("PSD offers preserve-layers and defaults to it", () => {
    const { path, format, set, exportBtn, last } = setup({ exportableLayers: LAYERS });
    set(path, "/a.psd");
    set(format, "psd");
    const mode = screen.getByLabelText("Mode") as HTMLSelectElement;
    expect(mode.value).toBe("multilayer");
    exportBtn();
    expect(last()).toMatchObject({ format: "psd", layerMode: "multilayer", perLayerIds: undefined });
    set(format, "png");
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("single");
  });

  it("formats without a layer model always export a single image", () => {
    const { path, format, set, exportBtn, last } = setup({ exportableLayers: LAYERS });
    set(path, "/a.png");
    set(screen.getByLabelText("Mode"), "separate");
    set(format, "pdf");
    expect(screen.queryByLabelText("Mode")).toBeNull();
    exportBtn();
    expect(last()).toMatchObject({ format: "pdf", layerMode: "single", perLayerIds: undefined });
  });

  it("Browse fills in the path chosen in the native dialog", async () => {
    const exportBrowse = vi.fn(async () => "D:/exports/final.png");
    vi.stubGlobal("api", { exportBrowse });
    const { path } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() => expect(path.value).toBe("D:/exports/final.png"));
    expect(exportBrowse).toHaveBeenCalledWith("png");
  });

  it("keeps the user's settings when the parent re-renders while open", () => {
    const { path, format, set, rerender, onConfirm, onCancel } = setup({ exportableLayers: LAYERS });
    set(path, "/a.jpg");
    set(format, "jpeg");
    rerender(
      <ExportDialog
        open
        documentWidth={1024}
        documentHeight={512}
        onConfirm={onConfirm}
        onCancel={onCancel}
        exportableLayers={LAYERS.map((l) => ({ ...l }))}
      />,
    );
    expect(path.value).toBe("/a.jpg");
    expect(format.value).toBe("jpeg");
  });

  it("Enter exports, Escape cancels", () => {
    const { onConfirm, onCancel, path, set } = setup();
    set(path, "/a.png");
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
