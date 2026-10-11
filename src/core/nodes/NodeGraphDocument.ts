import type { NodeGraph } from "./graphTypes";
import { graphAt, updateAt } from "./graphOps";

export interface GraphViewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * What the node canvas edits: a graph with undo, gestures and a remembered
 * viewport. Implemented by `NodeGraphDocument` (a root graph) and by
 * `SubgraphView` (a nested body inside a document).
 */
export interface GraphEditor {
  readonly graph: NodeGraph;
  readonly getSnapshot: () => NodeGraph;
  readonly subscribe: (fn: () => void) => () => void;
  readonly inGesture: boolean;
  commit(next: NodeGraph, mergeKey?: string): void;
  beginGesture(): void;
  preview(next: NodeGraph): void;
  endGesture(): void;
  cancelGesture(): void;
  undo(): void;
  redo(): void;
  view: GraphViewport | null;
}

const HISTORY_LIMIT = 200;
/** Consecutive commits with the same merge key inside this window become
 *  one undo step (e.g. scrubbing a value). */
const MERGE_WINDOW_MS = 1000;

/**
 * An editable graph with its own undo stack. Graph edits are independent
 * of the document's pixel history, so Ctrl+Z inside the node editor undoes
 * graph edits only.
 *
 * Three ways to change the graph:
 *  - `commit(next)` — one undo step (optionally merged by key).
 *  - `beginGesture()` / `preview(next)` / `endGesture()` — live updates
 *    during a drag that land as a single undo step on release.
 */
export class NodeGraphDocument implements GraphEditor {
  private _graph: NodeGraph;
  private _past: NodeGraph[] = [];
  private _future: NodeGraph[] = [];
  private _listeners = new Set<() => void>();
  private _gestureBase: NodeGraph | null = null;
  private _lastMerge: { key: string; at: number } | null = null;

  /** Last viewport the editor showed for this graph (not undoable). */
  view: GraphViewport | null = null;
  /** Last viewports of nested bodies, by path key (see `SubgraphView`). */
  readonly bodyViews = new Map<string, GraphViewport>();

  constructor(graph: NodeGraph) {
    this._graph = graph;
  }

  get graph(): NodeGraph {
    return this._graph;
  }

  readonly getSnapshot = (): NodeGraph => this._graph;

  readonly subscribe = (fn: () => void): (() => void) => {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  };

  commit(next: NodeGraph, mergeKey?: string): void {
    if (next === this._graph) return;
    if (this._gestureBase) {
      this._set(next);
      return;
    }
    const now = performance.now();
    const merge =
      mergeKey !== undefined &&
      this._lastMerge?.key === mergeKey &&
      now - this._lastMerge.at < MERGE_WINDOW_MS;
    if (!merge) this._pushPast(this._graph);
    this._lastMerge = mergeKey !== undefined ? { key: mergeKey, at: now } : null;
    this._future = [];
    this._set(next);
  }

  /** True between `beginGesture` and `endGesture` / `cancelGesture`. */
  get inGesture(): boolean {
    return this._gestureBase !== null;
  }

  /** Replace the graph from outside the editor (app undo, file load):
   *  graph-level undo history no longer applies and is dropped. */
  reset(graph: NodeGraph): void {
    this._gestureBase = null;
    this._past = [];
    this._future = [];
    this._lastMerge = null;
    this._set(graph);
  }

  beginGesture(): void {
    this._gestureBase = this._graph;
  }

  /** Replace the graph without recording history. Only valid inside a
   *  gesture. */
  preview(next: NodeGraph): void {
    this._set(next);
  }

  endGesture(): void {
    const base = this._gestureBase;
    this._gestureBase = null;
    if (base && base !== this._graph) {
      this._pushPast(base);
      this._future = [];
      this._lastMerge = null;
      // Listeners that skip mid-gesture updates sync now.
      this._listeners.forEach((fn) => fn());
    }
  }

  /** Abort a gesture, restoring the graph from before it started. */
  cancelGesture(): void {
    const base = this._gestureBase;
    this._gestureBase = null;
    if (base) this._set(base);
  }

  undo(): void {
    const prev = this._past.pop();
    if (!prev) return;
    this._future.push(this._graph);
    this._lastMerge = null;
    this._set(prev);
  }

  redo(): void {
    const next = this._future.pop();
    if (!next) return;
    this._past.push(this._graph);
    this._lastMerge = null;
    this._set(next);
  }

  private _pushPast(g: NodeGraph): void {
    this._past.push(g);
    if (this._past.length > HISTORY_LIMIT) this._past.shift();
  }

  private _set(next: NodeGraph): void {
    this._graph = next;
    this._listeners.forEach((fn) => fn());
  }
}

/**
 * Edits the body at `path` (owner node ids from the root) of a document.
 * Every change is written back through the owners, so the whole nest shares
 * the document's undo history.
 */
export class SubgraphView implements GraphEditor {
  private _last: NodeGraph;
  private readonly _key: string;

  constructor(
    private readonly doc: NodeGraphDocument,
    readonly path: readonly string[],
  ) {
    this._key = path.join("/");
    this._last = graphAt(doc.graph, path) ?? doc.graph;
  }

  /** The body, or the last one seen if an owner was removed (the editor
   *  pops back out on its next render). */
  get graph(): NodeGraph {
    const g = graphAt(this.doc.graph, this.path);
    if (g) this._last = g;
    return this._last;
  }

  readonly getSnapshot = (): NodeGraph => this.graph;
  readonly subscribe = (fn: () => void): (() => void) => this.doc.subscribe(fn);

  get inGesture(): boolean {
    return this.doc.inGesture;
  }

  get view(): GraphViewport | null {
    return this.doc.bodyViews.get(this._key) ?? null;
  }

  set view(v: GraphViewport | null) {
    if (v) this.doc.bodyViews.set(this._key, v);
    else this.doc.bodyViews.delete(this._key);
  }

  private _wrap(next: NodeGraph): NodeGraph {
    return updateAt(this.doc.graph, this.path, () => next);
  }

  commit(next: NodeGraph, mergeKey?: string): void {
    this.doc.commit(this._wrap(next), mergeKey && `${this._key}|${mergeKey}`);
  }
  preview(next: NodeGraph): void {
    this.doc.preview(this._wrap(next));
  }
  beginGesture(): void {
    this.doc.beginGesture();
  }
  endGesture(): void {
    this.doc.endGesture();
  }
  cancelGesture(): void {
    this.doc.cancelGesture();
  }
  undo(): void {
    this.doc.undo();
  }
  redo(): void {
    this.doc.redo();
  }
}
