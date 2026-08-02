import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react';
import type { CanvasVideoPreviewProbeView } from '@debrute/app-protocol';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { WorkbenchActions } from '../../types.js';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  canvasChangedRecordPaths,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';
import {
  canvasVideoPreviewSource,
  type CanvasVideoPreviewSource
} from './canvasVideoPreviews.js';
import { orderCanvasPreviewTasks } from './CanvasPreviewScheduling.js';
import {
  canvasVideoPreviewProbeWindow,
  canvasVideoPreviewTargetKey,
  reconcileCanvasVideoPreviewTasks,
  removeCanvasVideoPreviewTask,
  retryCanvasVideoPreviewTask,
  updateCanvasVideoPreviewTask,
  type CanvasVideoPreviewFailure,
  type CanvasVideoPreviewTarget,
  type CanvasVideoPreviewTask
} from './CanvasVideoPreviewTaskRegistry.js';
import { useCanvasPreviewInteractionGate } from './useCanvasPreviewInteractionGate.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';

interface CanvasVideoPreviewCanonicalSource {
  readonly targetKey: string;
  readonly sourceKey: string;
  readonly sourceWidth: number;
}

interface CanvasVideoPreviewPublishedSource {
  readonly targetKey: string;
  readonly sourceKey: string;
  readonly source: CanvasVideoPreviewSource;
}

interface CanvasVideoPreviewProbeRequestState {
  readonly abortController: AbortController;
  readonly targets: readonly CanvasVideoPreviewTarget[];
}

interface CanvasVideoPreviewEnsureRequestState {
  readonly abortController: AbortController;
  readonly target: CanvasVideoPreviewTarget;
}

export interface CanvasVideoPreviewRuntimeValue {
  reportPreviewError(input: {
    projectRelativePath: string;
    preview: CanvasVideoPreviewSource;
    message: string;
  }): void;
  retryPreview(projectRelativePath: string): void;
  getNodeSnapshot(node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export interface CanvasVideoPreviewNodeSnapshot {
  readonly preview: CanvasVideoPreviewSource | undefined;
  readonly previewError: string | undefined;
}

const CanvasVideoPreviewRuntimeContext = createContext<CanvasVideoPreviewRuntimeValue | undefined>(undefined);

export function useCanvasVideoPreviewRuntime(): CanvasVideoPreviewRuntimeValue {
  const runtime = useContext(CanvasVideoPreviewRuntimeContext);
  if (!runtime) {
    throw new Error('CanvasVideoPreviewProvider is required.');
  }
  return runtime;
}

export function useCanvasVideoPreviewNode(node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot {
  const runtime = useCanvasVideoPreviewRuntime();
  const subscribe = useCallback(
    (listener: () => void) => runtime.subscribeNode(node, listener),
    [node, runtime]
  );
  const getSnapshot = useCallback(() => runtime.getNodeSnapshot(node), [node, runtime]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function CanvasVideoPreviewProvider({
  canvasId,
  nodes,
  activeVideoPaths,
  actions,
  resourceZoom,
  devicePixelRatio,
  previewOrder,
  previewResourceScheduler,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeVideoPaths: ReadonlySet<string>;
  actions: WorkbenchActions;
  resourceZoom: number;
  devicePixelRatio: number;
  previewOrder: CanvasPreviewOrderSource;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasVideoPreviewTarget>>({});
  const [tasks, setTasks] = useState<Map<string, CanvasVideoPreviewTask>>(() => new Map());
  const [canonicalSources, setCanonicalSources] = useState<Record<string, CanvasVideoPreviewCanonicalSource>>({});
  const [previewSources, setPreviewSources] = useState<Record<string, CanvasVideoPreviewPublishedSource>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, { targetKey: string; message: string }>>({});
  const currentTargetsRef = useRef(currentTargets);
  const tasksRef = useRef(tasks);
  const canonicalSourcesRef = useRef(canonicalSources);
  const previewSourcesRef = useRef(previewSources);
  const previewErrorsRef = useRef(previewErrors);
  const changedNodePathsRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const probeRequestRef = useRef<CanvasVideoPreviewProbeRequestState | undefined>(undefined);
  const ensureRequestRef = useRef<CanvasVideoPreviewEnsureRequestState | undefined>(undefined);
  const mountedRef = useRef(true);
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  const previewInputsRef = useRef({ canvasId, nodesByPath, resourceZoom, devicePixelRatio });
  previewInputsRef.current = { canvasId, nodesByPath, resourceZoom, devicePixelRatio };

  currentTargetsRef.current = currentTargets;
  tasksRef.current = tasks;
  canonicalSourcesRef.current = canonicalSources;
  previewSourcesRef.current = previewSources;
  previewErrorsRef.current = previewErrors;

  const markChangedNodeRecords = useCallback(<Value,>(
    previous: Readonly<Record<string, Value>>,
    next: Readonly<Record<string, Value>>
  ) => {
    for (const path of canvasChangedRecordPaths(previous, next)) {
      changedNodePathsRef.current.add(path);
    }
  }, []);
  const updateTasks = useCallback((
    update: (current: Map<string, CanvasVideoPreviewTask>) => Map<string, CanvasVideoPreviewTask>
  ) => {
    setTasks((current) => {
      const next = update(current);
      tasksRef.current = next;
      return next;
    });
  }, []);
  const hasPendingPreviewWork = useCallback(() => (
    tasksRef.current.size > 0
    || Object.entries(canonicalSourcesRef.current).some(([path, source]) => {
      const target = currentTargetsRef.current[path];
      return target !== undefined && previewSourcesRef.current[path]?.targetKey !== source.targetKey;
    })
  ), []);
  const {
    interactionActiveRef,
    resumeVersion: interactionResumeVersion
  } = useCanvasPreviewInteractionGate({
    scheduler: previewResourceScheduler,
    hasPendingWork: hasPendingPreviewWork
  });

  const orderedTasks = useMemo(() => orderCanvasVideoPreviewTasks({
    tasks: [...tasks.values()],
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [nodesByPath, previewOrderSnapshot, tasks]);
  const orderedCurrentTargets = useMemo(() => orderCanvasVideoPreviewTargets({
    targets: Object.values(currentTargets),
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [currentTargets, nodesByPath, previewOrderSnapshot]);

  useEffect(() => {
    const targets = canvasVideoPreviewTargetsForNodes({ canvasId, nodes, activeVideoPaths });
    const nextTargets = Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
    const nextTargetKeys = new Map(targets.map((target) => [
      target.projectRelativePath,
      canvasVideoPreviewTargetKey(target)
    ]));
    currentTargetKeysRef.current = nextTargetKeys;
    setCurrentTargets((current) => sameCanvasVideoPreviewTargets(current, nextTargets) ? current : nextTargets);

    const retainedCanonicalSources = filterCurrentCanvasVideoPreviewRecords(
      canonicalSourcesRef.current,
      nextTargetKeys
    );
    canonicalSourcesRef.current = retainedCanonicalSources;
    setCanonicalSources((current) => {
      return sameRecordValues(current, retainedCanonicalSources) ? current : retainedCanonicalSources;
    });
    setPreviewSources((current) => {
      const next = filterCurrentCanvasVideoPreviewRecords(current, nextTargetKeys);
      if (!sameRecordValues(current, next)) {
        markChangedNodeRecords(current, next);
      }
      return sameRecordValues(current, next) ? current : next;
    });
    setPreviewErrors((current) => {
      const next = filterCurrentCanvasVideoPreviewRecords(current, nextTargetKeys);
      if (!sameRecordValues(current, next)) {
        markChangedNodeRecords(current, next);
      }
      return sameRecordValues(current, next) ? current : next;
    });

    updateTasks((current) => reconcileCanvasVideoPreviewTasks({
      previous: current,
      targets,
      readyTargetKeys: new Set(Object.values(retainedCanonicalSources).map((source) => source.targetKey))
    }));

    const ensureRequest = ensureRequestRef.current;
    if (ensureRequest
      && nextTargetKeys.get(ensureRequest.target.projectRelativePath)
        !== canvasVideoPreviewTargetKey(ensureRequest.target)) {
      ensureRequest.abortController.abort();
      ensureRequestRef.current = undefined;
    }
  }, [activeVideoPaths, canvasId, markChangedNodeRecords, nodes, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || probeRequestRef.current) {
      return;
    }
    const selected = canvasVideoPreviewProbeWindow(orderedTasks.filter((task) => (
      isCurrentCanvasVideoPreviewTarget(task, currentTargetKeysRef.current)
    )));
    if (selected.length === 0) {
      return;
    }
    const request: CanvasVideoPreviewProbeRequestState = {
      abortController: new AbortController(),
      targets: selected
    };
    probeRequestRef.current = request;
    updateTasks((current) => selected.reduce(
      (next, target) => updateCanvasVideoPreviewTask(next, target, { state: 'probing' }),
      current
    ));
    void actions.probeCanvasVideoPreviewSources({
      canvasId,
      targets: selected.map(canvasVideoPreviewTargetForApi)
    }, request.abortController.signal).then((result) => {
      if (!mountedRef.current || probeRequestRef.current !== request) {
        return;
      }
      probeRequestRef.current = undefined;
      for (const target of selected) {
        if (!isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)) {
          continue;
        }
        const source = result.sources[target.projectRelativePath];
        applyCanvasVideoPreviewProbeView(target, source);
      }
      wakePendingVideoPreviewTasks();
    }, (error: unknown) => {
      if (!mountedRef.current || probeRequestRef.current !== request) {
        return;
      }
      probeRequestRef.current = undefined;
      if (isAbortError(error)) {
        updateTasks((current) => selected.reduce((next, target) => (
          isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)
            ? updateCanvasVideoPreviewTask(next, target, { state: 'needs-probe' })
            : next
        ), current));
        wakePendingVideoPreviewTasks();
        return;
      }
      for (const target of selected) {
        if (isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)) {
          failCanvasVideoPreviewTarget(target, { stage: 'probe', message: messageFromUnknown(error) });
        }
      }
      wakePendingVideoPreviewTasks();
    });

    function applyCanvasVideoPreviewProbeView(
      target: CanvasVideoPreviewTarget,
      source: CanvasVideoPreviewProbeView | undefined
    ): void {
      if (!source
        || source.projectRelativePath !== target.projectRelativePath
        || source.videoRevision !== target.videoRevision
        || source.frameTimeMs !== target.frameTimeMs) {
        failCanvasVideoPreviewTarget(target, {
          stage: 'probe',
          message: `Canvas video preview probe response is missing ${target.projectRelativePath}.`
        });
        return;
      }
      if (source.status === 'failed') {
        failCanvasVideoPreviewTarget(target, { stage: 'probe', message: source.message });
        return;
      }
      clearCanvasVideoPreviewError(target);
      if (source.status === 'needs-source') {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, {
          state: 'needs-source',
          sourceKey: source.sourceKey
        }));
        return;
      }
      publishCanonicalCanvasVideoPreviewSource(target, {
        sourceKey: source.sourceKey,
        sourceWidth: source.sourceWidth
      });
    }

    function wakePendingVideoPreviewTasks(): void {
      updateTasks((current) => current.size > 0 ? new Map(current) : current);
    }
  }, [actions, canvasId, interactionResumeVersion, orderedTasks, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current || ensureRequestRef.current) {
      return;
    }
    const target = orderedTasks.find((task) => (
      task.state === 'needs-source'
      && isCurrentCanvasVideoPreviewTarget(task, currentTargetKeysRef.current)
    ));
    if (!target || target.state !== 'needs-source') {
      return;
    }
    const request: CanvasVideoPreviewEnsureRequestState = {
      abortController: new AbortController(),
      target
    };
    ensureRequestRef.current = request;
    updateTasks((current) => updateCanvasVideoPreviewTask(current, target, {
      state: 'ensuring',
      sourceKey: target.sourceKey
    }));
    void actions.ensureCanvasVideoPreviewSource({
      canvasId,
      target: canvasVideoPreviewTargetForApi(target),
      sourceKey: target.sourceKey
    }, request.abortController.signal).then((result) => {
      if (!mountedRef.current || ensureRequestRef.current !== request) {
        return;
      }
      ensureRequestRef.current = undefined;
      if (!isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)) {
        wakePendingVideoPreviewTasks();
        return;
      }
      if (result.status === 'failed') {
        failCanvasVideoPreviewTarget(target, { stage: 'ensure', message: result.message });
        return;
      }
      clearCanvasVideoPreviewError(target);
      if (result.status === 'source-changed') {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'needs-probe' }));
        return;
      }
      if (result.sourceKey !== target.sourceKey) {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'needs-probe' }));
        return;
      }
      publishCanonicalCanvasVideoPreviewSource(target, result);
    }, (error: unknown) => {
      if (!mountedRef.current || ensureRequestRef.current !== request) {
        return;
      }
      ensureRequestRef.current = undefined;
      if (!isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)) {
        wakePendingVideoPreviewTasks();
        return;
      }
      if (isAbortError(error)) {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, {
          state: 'needs-source',
          sourceKey: target.sourceKey
        }));
        return;
      }
      failCanvasVideoPreviewTarget(target, { stage: 'ensure', message: messageFromUnknown(error) });
    });

    function wakePendingVideoPreviewTasks(): void {
      updateTasks((current) => current.size > 0 ? new Map(current) : current);
    }
  }, [actions, canvasId, interactionResumeVersion, orderedTasks, updateTasks]);

  useEffect(() => {
    if (interactionActiveRef.current) {
      return;
    }
    for (const target of orderedCurrentTargets) {
      const canonicalSource = canonicalSources[target.projectRelativePath];
      const work = canvasVideoPreviewWorkForTarget({
        target,
        canonicalSource,
        node: nodesByPath.get(target.projectRelativePath),
        canvasId,
        resourceZoom,
        devicePixelRatio
      });
      if (work.kind === 'none') {
        continue;
      }
      const published = previewSources[target.projectRelativePath];
      if (published?.targetKey === work.targetKey && published.sourceKey === work.resourceKey) {
        continue;
      }
      currentResourceKeysRef.current.set(target.projectRelativePath, work.resourceKey);
      previewResourceScheduler.enqueue({
        kind: 'video',
        nodeId: target.projectRelativePath,
        sourceKey: work.resourceKey,
        targetWidth: work.preview.previewWidth,
        isCurrent: () => currentTargetKeysRef.current.get(target.projectRelativePath) === work.targetKey
          && currentResourceKeysRef.current.get(target.projectRelativePath) === work.resourceKey
          && !interactionActiveRef.current,
        run: () => {
          setPreviewSources((current) => {
            const next = {
              ...current,
              [target.projectRelativePath]: {
                targetKey: work.targetKey,
                sourceKey: work.resourceKey,
                source: work.preview
              }
            };
            markChangedNodeRecords(current, next);
            return next;
          });
          clearCanvasVideoPreviewError(target);
        }
      });
    }
  }, [
    canvasId,
    canonicalSources,
    devicePixelRatio,
    interactionResumeVersion,
    markChangedNodeRecords,
    nodesByPath,
    orderedCurrentTargets,
    previewResourceScheduler,
    previewSources,
    resourceZoom
  ]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      probeRequestRef.current?.abortController.abort();
      probeRequestRef.current = undefined;
      ensureRequestRef.current?.abortController.abort();
      ensureRequestRef.current = undefined;
      for (const projectRelativePath of currentTargetKeysRef.current.keys()) {
        previewResourceScheduler.cancel('video', projectRelativePath);
      }
    };
  }, [canvasId, previewResourceScheduler]);

  function publishCanonicalCanvasVideoPreviewSource(
    target: CanvasVideoPreviewTarget,
    source: { readonly sourceKey: string; readonly sourceWidth: number }
  ): void {
    const targetKey = canvasVideoPreviewTargetKey(target);
    setCanonicalSources((current) => {
      const next = {
        ...current,
        [target.projectRelativePath]: { targetKey, ...source }
      };
      canonicalSourcesRef.current = next;
      return next;
    });
    updateTasks((current) => removeCanvasVideoPreviewTask(current, target));
  }

  function failCanvasVideoPreviewTarget(
    target: CanvasVideoPreviewTarget,
    failure: CanvasVideoPreviewFailure
  ): void {
    if (!isCurrentCanvasVideoPreviewTarget(target, currentTargetKeysRef.current)) {
      return;
    }
    updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'failed', failure }));
    setPreviewErrors((current) => {
      const targetKey = canvasVideoPreviewTargetKey(target);
      const existing = current[target.projectRelativePath];
      if (existing?.targetKey === targetKey && existing.message === failure.message) {
        return current;
      }
      const next = {
        ...current,
        [target.projectRelativePath]: { targetKey, message: failure.message }
      };
      markChangedNodeRecords(current, next);
      return next;
    });
  }

  function clearCanvasVideoPreviewError(target: CanvasVideoPreviewTarget): void {
    setPreviewErrors((current) => {
      const existing = current[target.projectRelativePath];
      if (!existing || existing.targetKey !== canvasVideoPreviewTargetKey(target)) {
        return current;
      }
      const next = { ...current };
      delete next[target.projectRelativePath];
      markChangedNodeRecords(current, next);
      return next;
    });
  }

  const reportPreviewError = useCallback<CanvasVideoPreviewRuntimeValue['reportPreviewError']>(({
    projectRelativePath,
    preview,
    message
  }) => {
    const target = currentTargetsRef.current[projectRelativePath];
    if (!target) {
      return;
    }
    const targetKey = canvasVideoPreviewTargetKey(target);
    const published = previewSourcesRef.current[projectRelativePath];
    if (published?.targetKey !== targetKey || published.source.src !== preview.src) {
      return;
    }
    setPreviewErrors((current) => {
      const existing = current[projectRelativePath];
      if (existing?.targetKey === targetKey && existing.message === message) {
        return current;
      }
      const next = { ...current, [projectRelativePath]: { targetKey, message } };
      markChangedNodeRecords(current, next);
      return next;
    });
  }, [markChangedNodeRecords]);
  const retryPreview = useCallback<CanvasVideoPreviewRuntimeValue['retryPreview']>((projectRelativePath) => {
    const target = currentTargetsRef.current[projectRelativePath];
    const error = previewErrorsRef.current[projectRelativePath];
    if (!target || error?.targetKey !== canvasVideoPreviewTargetKey(target)) {
      return;
    }
    updateTasks((current) => {
      const retriedFailedTask = retryCanvasVideoPreviewTask(current, target);
      return retriedFailedTask !== current
        ? retriedFailedTask
        : new Map(current).set(projectRelativePath, { ...target, state: 'needs-probe' });
    });
    clearCanvasVideoPreviewError(target);
  }, [updateTasks]);

  const commandHandlersRef = useRef({ reportPreviewError, retryPreview });
  commandHandlersRef.current = { reportPreviewError, retryPreview };
  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot => {
    const target = currentTargetsRef.current[node.projectRelativePath];
    if (!target) {
      return { preview: undefined, previewError: undefined };
    }
    const targetKey = canvasVideoPreviewTargetKey(target);
    const published = previewSourcesRef.current[node.projectRelativePath];
    const error = previewErrorsRef.current[node.projectRelativePath];
    return {
      preview: published?.targetKey === targetKey ? published.source : undefined,
      previewError: error?.targetKey === targetKey ? error.message : undefined
    };
  }, []);
  const nodeSnapshotStore = useMemo(() => createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: (left: CanvasVideoPreviewNodeSnapshot, right: CanvasVideoPreviewNodeSnapshot) => (
      left.preview === right.preview && left.previewError === right.previewError
    )
  }), [deriveNodeSnapshot]);

  useLayoutEffect(() => {
    const changedPaths = new Set(changedNodePathsRef.current);
    changedNodePathsRef.current.clear();
    nodeSnapshotStore.flush(changedPaths);
  });

  const value = useMemo<CanvasVideoPreviewRuntimeValue>(() => ({
    reportPreviewError: (...args) => commandHandlersRef.current.reportPreviewError(...args),
    retryPreview: (...args) => commandHandlersRef.current.retryPreview(...args),
    getNodeSnapshot: nodeSnapshotStore.getSnapshot,
    subscribeNode: nodeSnapshotStore.subscribe
  }), [nodeSnapshotStore]);

  return (
    <CanvasVideoPreviewRuntimeContext.Provider value={value}>
      {children}
    </CanvasVideoPreviewRuntimeContext.Provider>
  );
}

type CanvasVideoPreviewWork =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'preview';
      readonly targetKey: string;
      readonly resourceKey: string;
      readonly preview: CanvasVideoPreviewSource;
    };

function canvasVideoPreviewWorkForTarget(input: {
  target: CanvasVideoPreviewTarget;
  canonicalSource: CanvasVideoPreviewCanonicalSource | undefined;
  node: ProjectedCanvasNode | undefined;
  canvasId: string;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasVideoPreviewWork {
  const targetKey = canvasVideoPreviewTargetKey(input.target);
  if (!input.node || input.canonicalSource?.targetKey !== targetKey) {
    return { kind: 'none' };
  }
  const preview = canvasVideoPreviewSource({
    canvasId: input.canvasId,
    node: input.node,
    sourceKey: input.canonicalSource.sourceKey,
    sourceWidth: input.canonicalSource.sourceWidth,
    frameTimeMs: input.target.frameTimeMs,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  return preview
    ? {
        kind: 'preview',
        targetKey,
        resourceKey: canvasVideoPreviewResourceSourceKey(
          targetKey,
          preview.previewWidth,
          input.canonicalSource.sourceKey
        ),
        preview
      }
    : { kind: 'none' };
}

export function canvasVideoPreviewTargetsForNodes(input: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeVideoPaths: ReadonlySet<string>;
}): CanvasVideoPreviewTarget[] {
  const targets: CanvasVideoPreviewTarget[] = [];
  for (const node of input.nodes) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'video'
      || node.availability.state !== 'available'
      || input.activeVideoPaths.has(node.projectRelativePath)) {
      continue;
    }
    targets.push({
      canvasId: input.canvasId,
      projectRelativePath: node.projectRelativePath,
      videoRevision: node.availability.revision,
      frameTimeMs: node.videoPlayback?.currentTimeMs ?? 0
    });
  }
  return targets;
}

export function orderCanvasVideoPreviewTargets(input: {
  targets: readonly CanvasVideoPreviewTarget[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasVideoPreviewTarget[] {
  const spatial = input.targets.flatMap((target) => {
    const node = input.nodesByPath.get(target.projectRelativePath);
    return node ? [{ target, ...node }] : [];
  });
  return orderCanvasPreviewTasks(spatial, input.visibleRect).map(({ target }) => target);
}

function orderCanvasVideoPreviewTasks(input: {
  tasks: readonly CanvasVideoPreviewTask[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasVideoPreviewTask[] {
  return orderCanvasVideoPreviewTargets({
    targets: input.tasks,
    nodesByPath: input.nodesByPath,
    visibleRect: input.visibleRect
  }) as CanvasVideoPreviewTask[];
}

function canvasVideoPreviewTargetForApi(target: CanvasVideoPreviewTarget): {
  projectRelativePath: string;
  videoRevision: string;
  frameTimeMs: number;
} {
  return {
    projectRelativePath: target.projectRelativePath,
    videoRevision: target.videoRevision,
    frameTimeMs: target.frameTimeMs
  };
}

function canvasVideoPreviewResourceSourceKey(targetKey: string, width: number, sourceKey: string): string {
  return `${targetKey}\u001f${sourceKey}\u001f${width}`;
}

function isCurrentCanvasVideoPreviewTarget(
  target: CanvasVideoPreviewTarget,
  currentTargetKeys: ReadonlyMap<string, string>
): boolean {
  return currentTargetKeys.get(target.projectRelativePath) === canvasVideoPreviewTargetKey(target);
}

function filterCurrentCanvasVideoPreviewRecords<Value extends { readonly targetKey: string }>(
  current: Readonly<Record<string, Value>>,
  currentTargetKeys: ReadonlyMap<string, string>
): Record<string, Value> {
  return Object.fromEntries(Object.entries(current).filter(([path, value]) => (
    currentTargetKeys.get(path) === value.targetKey
  )));
}

function sameCanvasVideoPreviewTargets(
  left: Readonly<Record<string, CanvasVideoPreviewTarget>>,
  right: Readonly<Record<string, CanvasVideoPreviewTarget>>
): boolean {
  return sameRecordValues(left, right, (leftTarget, rightTarget) => (
    canvasVideoPreviewTargetKey(leftTarget) === canvasVideoPreviewTargetKey(rightTarget)
  ));
}

function sameRecordValues<Value>(
  left: Readonly<Record<string, Value>>,
  right: Readonly<Record<string, Value>>,
  equals: (leftValue: Value, rightValue: Value) => boolean = Object.is
): boolean {
  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  return leftEntries.length === rightKeys.length
    && leftEntries.every(([key, value]) => key in right && equals(value, right[key]!));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
