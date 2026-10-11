import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppDispatch, useAppSelector } from "@/core/store/AppContext";
import type { CustomShaderEffectLayer } from "@/core/effects/CustomShader/CustomShaderEffect";
import { customShaderStatus } from "@/core/effects/CustomShader/customShaderStatus";
import { compileShaderGraph, type ShaderCompileError } from "@/core/nodes/shaderCompiler";
import { SubgraphView, type GraphEditor } from "@/core/nodes/NodeGraphDocument";
import { graphAt, nodeTitle, setArguments, setGraphInfo } from "@/core/nodes/graphOps";
import { checkShaderGraph, type ShaderIssue } from "@/core/effects/CustomShader/shaderCheck";
import { DEFAULT_INFO, serializeEffect } from "@/core/effects/CustomShader/effectFile";
import { customEffectStore } from "@/core/effects/CustomShader/customEffectStore";
import { EffectPropertiesPanel } from "../EffectPropertiesPanel/EffectPropertiesPanel";
import { nodeRegistry } from "@/core/nodes/nodeRegistry";
import type { GraphNode, NodeGraph } from "@/core/nodes/graphTypes";
import { NodeCanvas } from "../NodeCanvas/NodeCanvas";
import { nodeEditorStore } from "../nodeEditorStore";
import styles from "./ShaderLayerEditor.module.scss";

/** The node to flag for `error` when looking at the graph at `path`: the
 *  failing node itself, or the subgraph node on the way down to it. */
function errorNodeAt(error: ShaderCompileError | null, path: readonly string[]): string | null {
  if (!error || path.some((id, i) => error.path[i] !== id)) return null;
  return error.path.length === path.length ? error.nodeId : error.path[path.length];
}

/** Breadcrumb titles for each owner on `path`. */
function pathTitles(root: NodeGraph, path: readonly string[]): string[] {
  const titles: string[] = [];
  let g: NodeGraph | undefined = root;
  for (const id of path) {
    const node: GraphNode | undefined = g?.nodes.find((n) => n.id === id);
    const def = node && nodeRegistry.get(node.type);
    if (!g || !node || !def) break;
    titles.push(nodeTitle(def, node, g));
    g = node.body;
  }
  return titles;
}

/** The full check (incl. GPU validation) runs once edits pause this long. */
const CHECK_DEBOUNCE_MS = 300;

/** App history is recorded once edits pause for this long. */
const HISTORY_DEBOUNCE_MS = 600;

interface ShaderLayerEditorProps {
  layerId: string | null;
  captureHistory: (label: string) => void;
}

function isCustomShaderLayer(l: unknown): l is CustomShaderEffectLayer {
  return (
    typeof l === "object" &&
    l !== null &&
    (l as { type?: string }).type === "adjustment" &&
    (l as { effectType?: string }).effectType === "custom-shader"
  );
}

/** The Shader tab: edits the graph of one Custom Shader layer. */
export function ShaderLayerEditor({
  layerId,
  captureHistory,
}: ShaderLayerEditorProps): React.JSX.Element {
  const layer = useAppSelector((s) => {
    const l = layerId ? s.layers.find((x) => x.id === layerId) : undefined;
    return isCustomShaderLayer(l) ? l : null;
  });
  const parentName = useAppSelector((s) =>
    layer ? (s.layers.find((x) => x.id === layer.parentId)?.name ?? "Layer") : "",
  );

  if (!layer) {
    return (
      <div className={styles.empty}>
        <p>No Custom Shader selected.</p>
        <p className={styles.emptyHint}>
          Add one with <strong>Effects → Custom Shader</strong>, or click a Custom Shader
          effect in the Layers panel to edit it here.
        </p>
      </div>
    );
  }
  return (
    <BoundEditor
      key={layer.id}
      layer={layer}
      parentName={parentName}
      captureHistory={captureHistory}
    />
  );
}

function BoundEditor({
  layer,
  parentName,
  captureHistory,
}: {
  layer: CustomShaderEffectLayer;
  parentName: string;
  captureHistory: (label: string) => void;
}): React.JSX.Element {
  const dispatch = useAppDispatch();
  const doc = nodeEditorStore.layerDocument(layer.id, layer.params.graph);
  const graph = useSyncExternalStore(doc.subscribe, doc.getSnapshot);
  const gpuError = useSyncExternalStore(customShaderStatus.subscribe, () =>
    customShaderStatus.gpuError(layer.id),
  );

  const layerRef = useRef(layer);
  layerRef.current = layer;
  const captureRef = useRef(captureHistory);
  captureRef.current = captureHistory;
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Editor → layer. Mid-gesture previews (node drags) are skipped; the
  // document notifies again when the gesture ends.
  useEffect(() => {
    const sync = (): void => {
      const current = layerRef.current;
      if (doc.inGesture || doc.graph === current.params.graph) return;
      dispatch({
        type: "UPDATE_ADJUSTMENT_LAYER",
        payload: { ...current, params: { ...current.params, graph: doc.graph } },
      });
      if (historyTimer.current) clearTimeout(historyTimer.current);
      historyTimer.current = setTimeout(() => {
        historyTimer.current = null;
        captureRef.current("Edit Custom Shader");
      }, HISTORY_DEBOUNCE_MS);
    };
    const unsubscribe = doc.subscribe(sync);
    return () => {
      unsubscribe();
      // Don't lose the last edit's history entry when the editor closes.
      if (historyTimer.current) {
        clearTimeout(historyTimer.current);
        historyTimer.current = null;
        captureRef.current("Edit Custom Shader");
      }
    };
  }, [doc, dispatch]);

  // Layer → editor: the graph was replaced from outside (app undo/redo,
  // document reload).
  useEffect(() => {
    if (doc.inGesture || layer.params.graph === doc.graph) return;
    if (historyTimer.current) {
      clearTimeout(historyTimer.current);
      historyTimer.current = null;
    }
    doc.reset(layer.params.graph);
  }, [doc, layer.params.graph]);

  // Which body is open: owner node ids from the root graph.
  const [path, setPath] = useState<readonly string[]>([]);
  const pathKey = path.join("/");
  // An owner on the path was removed (undo, delete): back out to what exists.
  const valid = graphAt(graph, path) !== null;
  useEffect(() => {
    if (valid) return;
    let keep = path.length;
    while (keep > 0 && !graphAt(graph, path.slice(0, keep))) keep--;
    setPath(path.slice(0, keep));
  }, [valid, graph, path]);

  const editor: GraphEditor = useMemo(
    () => (path.length === 0 ? doc : new SubgraphView(doc, path)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by content
    [doc, pathKey],
  );

  const compiled = useMemo(() => compileShaderGraph(graph, { linear: false }), [graph]);
  const error = !compiled.ok ? compiled.errors[0] : null;
  const titles = pathTitles(graph, path);

  // ── Properties panel: full check, metadata, saving ──────────────────────
  const propsOpen = useSyncExternalStore(nodeEditorStore.subscribe, nodeEditorStore.getPropertiesOpen);
  const [issues, setIssues] = useState<readonly ShaderIssue[] | null>(null);
  useEffect(() => {
    let current = true;
    setIssues(null);
    const timer = setTimeout(() => {
      void checkShaderGraph(graph).then((r) => {
        if (current) setIssues(r);
      });
    }, CHECK_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [graph]);

  /** Jump to a node: open its subgraph level, then select + frame it. */
  const [focus, setFocus] = useState<{ id: string; seq: number } | null>(null);
  const showIssue = (issue: ShaderIssue): void => {
    if (!issue.nodeId) return;
    setPath(issue.path);
    setFocus((f) => ({ id: issue.nodeId!, seq: (f?.seq ?? 0) + 1 }));
  };

  const info = graph.info ?? DEFAULT_INFO;
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const source = layer.params.source ?? null;
  /** Save: overwrite the linked file; Save As: pick a file and link to it. */
  const save = async (as: boolean): Promise<void> => {
    setSaving(true);
    setSaveMessage(null);
    try {
      const text = serializeEffect(graph);
      let path: string | null = null;
      if (!as && source) {
        await window.api.writeEffectFile(source, text);
        path = source;
      } else {
        path = await window.api.saveEffectFile(text, info.name);
      }
      if (path) {
        setSaveMessage({ ok: true, text: `Saved to ${path}` });
        if (path !== source) {
          const current = layerRef.current;
          dispatch({
            type: "UPDATE_ADJUSTMENT_LAYER",
            payload: { ...current, params: { ...current.params, source: path } },
          });
        }
        void customEffectStore.reload();
      }
    } catch (err) {
      setSaveMessage({ ok: false, text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSaving(false);
    }
  };
  const openFolder = (): void => {
    window.api.openEffectsFolder().catch((err: unknown) =>
      setSaveMessage({
        ok: false,
        text: `Couldn't open the folder: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
  };

  return (
    <div className={styles.root}>
      <div className={styles.infoBar}>
        <nav className={styles.crumbs} aria-label="Graph level">
          <button
            type="button"
            className={styles.crumb}
            disabled={path.length === 0}
            onClick={() => setPath([])}
          >
            <strong>{layer.name}</strong> on {parentName}
          </button>
          {titles.map((t, i) => (
            <React.Fragment key={path[i]}>
              <span className={styles.sep}>›</span>
              <button
                type="button"
                className={styles.crumb}
                disabled={i === titles.length - 1}
                onClick={() => setPath(path.slice(0, i + 1))}
              >
                {t}
              </button>
            </React.Fragment>
          ))}
        </nav>
        {error ? (
          <span className={styles.error} title={error.message}>
            ⚠ {error.message} — showing the layer unchanged
          </span>
        ) : gpuError ? (
          <span className={styles.error} title={gpuError}>
            ⚠ Shader failed to compile — see the console
          </span>
        ) : (
          <span className={styles.ok}>✓ Live</span>
        )}
        <button
          type="button"
          className={`${styles.toggle}${propsOpen ? ` ${styles.toggleOn}` : ""}`}
          aria-pressed={propsOpen}
          onClick={() => nodeEditorStore.setPropertiesOpen(!propsOpen)}
        >
          Properties
        </button>
      </div>
      <div className={styles.main}>
        {valid && (
          <NodeCanvas
            key={pathKey}
            doc={editor}
            errorNodeId={errorNodeAt(error, path)}
            focusNode={focus}
            onOpenBody={(id) => setPath([...path, id])}
            onExitBody={path.length > 0 ? () => setPath(path.slice(0, -1)) : undefined}
          />
        )}
        {propsOpen && (
          <EffectPropertiesPanel
            info={info}
            onInfoChange={(patch) => doc.commit(setGraphInfo(doc.graph, patch))}
            args={graph.arguments ?? []}
            onArgumentsChange={(args) => doc.commit(setArguments(doc.graph, args))}
            issues={issues}
            onIssueClick={showIssue}
            source={source}
            onSave={() => void save(false)}
            onSaveAs={() => void save(true)}
            saving={saving}
            saveMessage={saveMessage}
            onOpenFolder={openFolder}
          />
        )}
      </div>
    </div>
  );
}
