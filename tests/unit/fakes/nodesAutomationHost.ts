/**
 * In-memory `AutomationHost` for automation-runner and node tests. Keeps a
 * tiny document / layer model, records every call in `calls`, and lets
 * tests make any method throw (`failOn`).
 */
import type {
  AddEffectOptions,
  AutomationHost,
  DocumentInfo,
  FsEntry,
  FsStat,
  LayerProperties,
  LayerPropertyPatch,
  LayerQuery,
} from "@/core/nodes/automationHost";
import type { DocumentRef, LayerRef } from "@/core/nodes/values";

interface FakeLayer {
  ref: LayerRef;
  props: LayerProperties;
}

interface FakeDoc {
  ref: DocumentRef;
  info: DocumentInfo;
  layers: FakeLayer[];
  active: string | null;
}

export interface FakeCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

const layerProps = (name: string): LayerProperties => ({
  name,
  kind: "pixel",
  visible: true,
  opacity: 1,
  blendMode: "normal",
  locked: false,
  x: 0,
  y: 0,
  width: 64,
  height: 64,
  effectType: "",
});

export class FakeAutomationHost implements AutomationHost {
  readonly calls: FakeCall[] = [];
  readonly logs: string[] = [];
  readonly files = new Map<string, FsEntry[]>();
  private docs: FakeDoc[] = [];
  private activeDoc: FakeDoc | null = null;
  private failures = new Map<string, Error>();
  private counter = 0;
  private selection: { x: number; y: number; width: number; height: number } | null = null;

  constructor(options: { width?: number; height?: number; format?: string; layers?: string[] } = {}) {
    const doc = this.makeDoc("Doc 1", options.width ?? 64, options.height ?? 32, options.format ?? "rgba8");
    for (const name of options.layers ?? ["Background"]) this.addLayer(doc, name);
    doc.active = doc.layers[0]?.ref.id ?? null;
  }

  /** Make `method` throw `error` on every call. */
  failOn(method: keyof AutomationHost, error: Error | string): this {
    this.failures.set(method, typeof error === "string" ? new Error(error) : error);
    return this;
  }

  callsTo(method: keyof AutomationHost): FakeCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  private rec(method: keyof AutomationHost, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const f = this.failures.get(method);
    if (f) throw f;
  }

  private makeDoc(name: string, width: number, height: number, format: string): FakeDoc {
    const doc: FakeDoc = {
      ref: { kind: "document", id: `doc${++this.counter}`, name },
      info: { name, width, height, format, path: "", dirty: false },
      layers: [],
      active: null,
    };
    this.docs.push(doc);
    this.activeDoc ??= doc;
    return doc;
  }

  private addLayer(doc: FakeDoc, name: string): LayerRef {
    const ref: LayerRef = { kind: "layer", id: `layer${++this.counter}`, name, docId: doc.ref.id };
    doc.layers.unshift({ ref, props: layerProps(name) });
    return ref;
  }

  private doc(): FakeDoc {
    if (!this.activeDoc) throw new Error("No document open");
    return this.activeDoc;
  }

  private find(layer: LayerRef): FakeLayer {
    for (const d of this.docs) {
      const l = d.layers.find((x) => x.ref.id === layer.id);
      if (l) return l;
    }
    throw new Error(`Layer "${layer.name}" not found`);
  }

  /** Every layer of the active document, top to bottom. */
  layerNames(): string[] {
    return this.doc().layers.map((l) => l.props.name);
  }

  log(message: string): void {
    this.rec("log", message);
    this.logs.push(message);
  }

  // ── Documents ────────────────────────────────────────────────────────────
  activeDocument(): DocumentRef | null {
    this.rec("activeDocument");
    return this.activeDoc?.ref ?? null;
  }
  documents(): DocumentRef[] {
    this.rec("documents");
    return this.docs.map((d) => d.ref);
  }
  async activateDocument(doc: DocumentRef): Promise<void> {
    this.rec("activateDocument", doc);
    const d = this.docs.find((x) => x.ref.id === doc.id);
    if (!d) throw new Error("Document is closed");
    this.activeDoc = d;
  }
  document(): DocumentInfo {
    this.rec("document");
    return this.doc().info;
  }
  async newDocument(settings: { name?: string; width: number; height: number }): Promise<DocumentRef> {
    this.rec("newDocument", settings);
    const d = this.makeDoc(settings.name ?? "Untitled", settings.width, settings.height, "rgba8");
    this.addLayer(d, "Background");
    this.activeDoc = d;
    return d.ref;
  }
  async openDocument(path: string): Promise<DocumentRef> {
    this.rec("openDocument", path);
    const d = this.makeDoc(path.split(/[\\/]/).pop() ?? path, 10, 10, "rgba8");
    this.activeDoc = d;
    return d.ref;
  }
  async closeDocument(doc: DocumentRef): Promise<void> {
    this.rec("closeDocument", doc);
    this.docs = this.docs.filter((d) => d.ref.id !== doc.id);
    if (this.activeDoc?.ref.id === doc.id) this.activeDoc = this.docs[0] ?? null;
  }
  async saveDocument(path?: string, asCopy?: boolean): Promise<void> {
    this.rec("saveDocument", path, asCopy);
  }
  async exportImage(settings: unknown): Promise<void> {
    this.rec("exportImage", settings);
  }

  // ── Files ────────────────────────────────────────────────────────────────
  async listDirectory(path: string, options: { recursive: boolean; files: boolean; folders: boolean }): Promise<FsEntry[]> {
    this.rec("listDirectory", path, options);
    return (this.files.get(path) ?? []).filter((e) => (e.isDirectory ? options.folders : options.files));
  }
  async statPath(path: string): Promise<FsStat> {
    this.rec("statPath", path);
    return { exists: false, isDirectory: false, isFile: false, size: 0, modified: 0, created: 0 };
  }
  async makeDirectory(path: string): Promise<void> {
    this.rec("makeDirectory", path);
  }
  supportedImageExtensions(): readonly string[] {
    this.rec("supportedImageExtensions");
    return ["png", "jpg", "jpeg", "webp"];
  }

  // ── Image ────────────────────────────────────────────────────────────────
  async resizeImage(width: number, height: number, resample: string): Promise<void> {
    this.rec("resizeImage", width, height, resample);
    this.doc().info = { ...this.doc().info, width, height };
  }
  async resizeCanvas(width: number, height: number, anchor: unknown): Promise<void> {
    this.rec("resizeCanvas", width, height, anchor);
    this.doc().info = { ...this.doc().info, width, height };
  }
  async cropImage(rect: { x: number; y: number; width: number; height: number }): Promise<void> {
    this.rec("cropImage", rect);
  }
  async trimImage(): Promise<void> {
    this.rec("trimImage");
  }
  async rotateImage(amount: string): Promise<void> {
    this.rec("rotateImage", amount);
  }
  async flipImage(axis: string): Promise<void> {
    this.rec("flipImage", axis);
  }
  async convertColorMode(format: string, sourceColorSpace?: string): Promise<void> {
    this.rec("convertColorMode", format, sourceColorSpace);
  }
  async upscaleModels(): Promise<{ id: string; label: string }[]> {
    this.rec("upscaleModels");
    return [{ id: "x4", label: "Real-ESRGAN x4" }];
  }
  async rescaleImage(width: number, height: number, modelId: string): Promise<void> {
    this.rec("rescaleImage", width, height, modelId);
  }
  async restoreImage(modelId: string): Promise<void> {
    this.rec("restoreImage", modelId);
  }

  // ── Layers ───────────────────────────────────────────────────────────────
  activeLayer(): LayerRef | null {
    this.rec("activeLayer");
    const d = this.activeDoc;
    return d?.layers.find((l) => l.ref.id === d.active)?.ref ?? null;
  }
  async setActiveLayer(layer: LayerRef): Promise<void> {
    this.rec("setActiveLayer", layer);
    this.find(layer);
    this.doc().active = layer.id;
  }
  async selectLayers(layers: readonly LayerRef[]): Promise<void> {
    this.rec("selectLayers", layers);
  }
  async selectAllLayers(): Promise<void> {
    this.rec("selectAllLayers");
  }
  async deselectLayers(): Promise<void> {
    this.rec("deselectLayers");
  }
  layers(query: LayerQuery): LayerRef[] {
    this.rec("layers", query);
    return this.doc()
      .layers.filter((l) => !query.visibleOnly || l.props.visible)
      .map((l) => l.ref);
  }
  layerProperties(layer: LayerRef): LayerProperties {
    this.rec("layerProperties", layer);
    return this.find(layer).props;
  }
  layerChildren(layer: LayerRef): LayerRef[] {
    this.rec("layerChildren", layer);
    return [];
  }
  layerParent(layer: LayerRef): LayerRef | null {
    this.rec("layerParent", layer);
    return null;
  }
  async newLayer(options: { name?: string; above?: LayerRef | null }): Promise<LayerRef> {
    this.rec("newLayer", options);
    const ref = this.addLayer(this.doc(), options.name ?? `Layer ${this.doc().layers.length + 1}`);
    this.doc().active = ref.id;
    return ref;
  }
  async newGroup(options: { name?: string }): Promise<LayerRef> {
    this.rec("newGroup", options);
    return this.addLayer(this.doc(), options.name ?? "Group");
  }
  async duplicateLayer(layer: LayerRef, name?: string): Promise<LayerRef> {
    this.rec("duplicateLayer", layer, name);
    return this.addLayer(this.doc(), name ?? `${layer.name} copy`);
  }
  async deleteLayer(layer: LayerRef): Promise<void> {
    this.rec("deleteLayer", layer);
    this.find(layer);
    const d = this.doc();
    d.layers = d.layers.filter((l) => l.ref.id !== layer.id);
  }
  async setLayerProperties(layer: LayerRef, patch: LayerPropertyPatch): Promise<LayerRef> {
    this.rec("setLayerProperties", layer, patch);
    const l = this.find(layer);
    const { colorSpace: _ignored, ...rest } = patch;
    l.props = { ...l.props, ...rest };
    if (patch.name !== undefined) l.ref = { ...l.ref, name: patch.name };
    return l.ref;
  }
  async moveLayer(layer: LayerRef, x: number, y: number, relative: boolean): Promise<void> {
    this.rec("moveLayer", layer, x, y, relative);
  }
  async arrangeLayers(layers: readonly LayerRef[], op: string): Promise<void> {
    this.rec("arrangeLayers", layers, op);
  }
  async moveLayerToGroup(layer: LayerRef, group: LayerRef | null, index: number): Promise<void> {
    this.rec("moveLayerToGroup", layer, group, index);
  }
  async groupLayers(layers: readonly LayerRef[], options: { name?: string }): Promise<LayerRef> {
    this.rec("groupLayers", layers, options);
    return this.addLayer(this.doc(), options.name ?? "Group");
  }
  async ungroupLayers(group: LayerRef): Promise<void> {
    this.rec("ungroupLayers", group);
  }
  async mergeLayers(layers: readonly LayerRef[]): Promise<LayerRef> {
    this.rec("mergeLayers", layers);
    return layers[0];
  }
  async mergeDown(layer: LayerRef): Promise<LayerRef> {
    this.rec("mergeDown", layer);
    return layer;
  }
  async mergeVisible(): Promise<LayerRef> {
    this.rec("mergeVisible");
    return this.doc().layers[0].ref;
  }
  async mergeGroup(group: LayerRef): Promise<LayerRef> {
    this.rec("mergeGroup", group);
    return group;
  }
  async flattenImage(): Promise<LayerRef> {
    this.rec("flattenImage");
    return this.doc().layers[0].ref;
  }
  async rasterizeLayer(layer: LayerRef): Promise<LayerRef> {
    this.rec("rasterizeLayer", layer);
    return layer;
  }
  async addLayerMask(layer: LayerRef, fromSelection: boolean): Promise<LayerRef> {
    this.rec("addLayerMask", layer, fromSelection);
    return layer;
  }
  async alignLayers(layers: readonly LayerRef[], edge: string): Promise<void> {
    this.rec("alignLayers", layers, edge);
  }
  async distributeLayers(layers: readonly LayerRef[], axis: string): Promise<void> {
    this.rec("distributeLayers", layers, axis);
  }
  async rotateLayers(layers: readonly LayerRef[], amount: string): Promise<void> {
    this.rec("rotateLayers", layers, amount);
  }
  async flipLayers(layers: readonly LayerRef[], axis: string): Promise<void> {
    this.rec("flipLayers", layers, axis);
  }
  async importImageAsLayer(path: string, options: { name?: string }): Promise<LayerRef> {
    this.rec("importImageAsLayer", path, options);
    return this.addLayer(this.doc(), options.name ?? path);
  }
  async newLinkedLayer(path: string, name?: string): Promise<LayerRef> {
    this.rec("newLinkedLayer", path, name);
    return this.addLayer(this.doc(), name ?? path);
  }
  async refreshLinkedLayer(layer: LayerRef): Promise<void> {
    this.rec("refreshLinkedLayer", layer);
  }
  async fillLayer(layer: LayerRef, color: readonly number[]): Promise<void> {
    this.rec("fillLayer", layer, color);
  }
  async clearLayer(layer: LayerRef): Promise<void> {
    this.rec("clearLayer", layer);
  }

  // ── Effects ──────────────────────────────────────────────────────────────
  async addEffect(options: AddEffectOptions): Promise<LayerRef> {
    this.rec("addEffect", options);
    return this.addLayer(this.doc(), options.name ?? options.effectType);
  }
  async loadCustomEffect(nameOrPath: string): Promise<{ name: string; graph: unknown; path: string | null }> {
    this.rec("loadCustomEffect", nameOrPath);
    return { name: nameOrPath, graph: {}, path: null };
  }
  async setEffectValues(effect: LayerRef, values: Readonly<Record<string, unknown>>): Promise<void> {
    this.rec("setEffectValues", effect, values);
  }

  // ── Selection ────────────────────────────────────────────────────────────
  async selectAll(): Promise<void> {
    this.rec("selectAll");
    this.selection = { x: 0, y: 0, width: this.doc().info.width, height: this.doc().info.height };
  }
  async deselect(): Promise<void> {
    this.rec("deselect");
    this.selection = null;
  }
  async invertSelection(): Promise<void> {
    this.rec("invertSelection");
  }
  async selectRect(rect: { x: number; y: number; width: number; height: number }, mode: string, feather: number): Promise<void> {
    this.rec("selectRect", rect, mode, feather);
    this.selection = rect;
  }
  async selectLayerAlpha(layer: LayerRef, mode: string): Promise<void> {
    this.rec("selectLayerAlpha", layer, mode);
  }
  hasSelection(): boolean {
    this.rec("hasSelection");
    return this.selection !== null;
  }
  selectionBounds(): { x: number; y: number; width: number; height: number } | null {
    this.rec("selectionBounds");
    return this.selection;
  }

  // ── Edit ─────────────────────────────────────────────────────────────────
  async copy(layer: LayerRef, merged: boolean): Promise<void> {
    this.rec("copy", layer, merged);
  }
  async cut(layer: LayerRef): Promise<void> {
    this.rec("cut", layer);
  }
  async paste(): Promise<LayerRef> {
    this.rec("paste");
    return this.addLayer(this.doc(), "Pasted");
  }
  async pasteInto(): Promise<LayerRef> {
    this.rec("pasteInto");
    return this.addLayer(this.doc(), "Pasted");
  }
  async contentAwareFill(layer: LayerRef, mode: "fill" | "delete", samplingRadius: number): Promise<void> {
    this.rec("contentAwareFill", layer, mode, samplingRadius);
  }
}
