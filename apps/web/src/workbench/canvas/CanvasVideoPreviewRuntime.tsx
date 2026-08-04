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
import {
  canvasPreviewCanonicalSourceIdentity,
  canvasPreviewContinuityKey,
  type CanvasPreviewCanonicalSourceIdentity,
  type CanvasPreviewTargetKey,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { CanvasSceneActions } from './CanvasSceneActions.js';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  canvasChangedRecordPaths,
  canvasRecordsMatchingTargetKeys,
  canvasRecordValuesEqual,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';
import {
  canvasVideoPreviewUrl
} from './canvasVideoPreviews.js';
import {
  sameCanvasRasterPreviewRequest,
  type CanvasRasterPreviewRequest
} from './CanvasRasterPreviewPresentation.js';
import { canvasRawFileProjectId } from './canvasRawFileUrls.js';
import { orderCanvasPreviewItemsByNode } from './CanvasPreviewScheduling.js';
import {
  canvasVideoPreviewProbeWindow,
  canvasVideoPreviewTargetIdentity,
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
  readonly targetKey: CanvasPreviewTargetKey;
  readonly canonicalSourceIdentity: CanvasPreviewCanonicalSourceIdentity;
  readonly sourceWidth: number;
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
  retryPreview(projectRelativePath: string): void;
  getNodeSnapshot(node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot;
  subscribeNode(node: ProjectedCanvasNode, listener: () => void): () => void;
}

export interface CanvasVideoPreviewNodeSnapshot {
  readonly request: CanvasRasterPreviewRequest;
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
  previewOrder,
  previewResourceScheduler,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeVideoPaths: ReadonlySet<string>;
  actions: CanvasSceneActions;
  previewOrder: CanvasPreviewOrderSource;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasVideoPreviewTarget>>({});
  const [tasks, setTasks] = useState<Map<string, CanvasVideoPreviewTask>>(() => new Map());
  const [canonicalSources, setCanonicalSources] = useState<Record<string, CanvasVideoPreviewCanonicalSource>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, {
    targetKey: CanvasPreviewTargetKey;
    message: string;
  }>>({});
  const currentTargetsRef = useRef(currentTargets);
  const tasksRef = useRef(tasks);
  const canonicalSourcesRef = useRef(canonicalSources);
  const previewErrorsRef = useRef(previewErrors);
  const changedNodePathsRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, CanvasPreviewTargetKey>());
  const probeRequestRef = useRef<CanvasVideoPreviewProbeRequestState | undefined>(undefined);
  const ensureRequestRef = useRef<CanvasVideoPreviewEnsureRequestState | undefined>(undefined);
  const mountedRef = useRef(true);
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  currentTargetsRef.current = currentTargets;
  tasksRef.current = tasks;
  canonicalSourcesRef.current = canonicalSources;
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
  useEffect(() => {
    const targets = canvasVideoPreviewTargetsForNodes({ canvasId, nodes });
    const workTargets = targets.filter((target) => !activeVideoPaths.has(target.projectRelativePath));
    const nextTargets = Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
    const nextTargetKeys = new Map(targets.map((target) => [
      target.projectRelativePath,
      canvasVideoPreviewTargetKey(target)
    ]));
    currentTargetKeysRef.current = nextTargetKeys;
    setCurrentTargets((current) => {
      if (sameCanvasVideoPreviewTargets(current, nextTargets)) {
        return current;
      }
      markChangedNodeRecords(current, nextTargets);
      return nextTargets;
    });

    const retainedCanonicalSources = canvasRecordsMatchingTargetKeys(
      canonicalSourcesRef.current,
      nextTargetKeys
    );
    canonicalSourcesRef.current = retainedCanonicalSources;
    setCanonicalSources((current) => {
      if (canvasRecordValuesEqual(current, retainedCanonicalSources)) {
        return current;
      }
      markChangedNodeRecords(current, retainedCanonicalSources);
      return retainedCanonicalSources;
    });
    setPreviewErrors((current) => {
      const next = canvasRecordsMatchingTargetKeys(current, nextTargetKeys);
      if (!canvasRecordValuesEqual(current, next)) {
        markChangedNodeRecords(current, next);
      }
      return canvasRecordValuesEqual(current, next) ? current : next;
    });

    updateTasks((current) => reconcileCanvasVideoPreviewTasks({
      previous: current,
      targets: workTargets,
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
        || source.sourceRevision !== target.sourceRevision
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
          canonicalSourceIdentity: canvasPreviewCanonicalSourceIdentity(source.canonicalSourceIdentity)
        }));
        return;
      }
      publishCanonicalCanvasVideoPreviewSource(target, {
        canonicalSourceIdentity: canvasPreviewCanonicalSourceIdentity(source.canonicalSourceIdentity),
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
      canonicalSourceIdentity: target.canonicalSourceIdentity
    }));
    void actions.ensureCanvasVideoPreviewSource({
      canvasId,
      target: canvasVideoPreviewTargetForApi(target),
      canonicalSourceIdentity: target.canonicalSourceIdentity
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
      if (result.canonicalSourceIdentity !== target.canonicalSourceIdentity) {
        updateTasks((current) => updateCanvasVideoPreviewTask(current, target, { state: 'needs-probe' }));
        return;
      }
      publishCanonicalCanvasVideoPreviewSource(target, {
        canonicalSourceIdentity: canvasPreviewCanonicalSourceIdentity(result.canonicalSourceIdentity),
        sourceWidth: result.sourceWidth
      });
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
          canonicalSourceIdentity: target.canonicalSourceIdentity
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
    source: {
      readonly canonicalSourceIdentity: CanvasPreviewCanonicalSourceIdentity;
      readonly sourceWidth: number;
    }
  ): void {
    const targetKey = canvasVideoPreviewTargetKey(target);
    setCanonicalSources((current) => {
      const next = {
        ...current,
        [target.projectRelativePath]: { targetKey, ...source }
      };
      canonicalSourcesRef.current = next;
      markChangedNodeRecords(current, next);
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

  const commandHandlersRef = useRef({ retryPreview });
  commandHandlersRef.current = { retryPreview };
  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot => {
    const target = currentTargetsRef.current[node.projectRelativePath];
    if (!target) {
      return { request: {}, previewError: undefined };
    }
    const targetKey = canvasVideoPreviewTargetKey(target);
    const canonicalSource = canonicalSourcesRef.current[node.projectRelativePath];
    const error = previewErrorsRef.current[node.projectRelativePath];
    return {
      request: canvasVideoRasterPreviewRequest({
        target,
        canonicalSource: canonicalSource?.targetKey === targetKey ? canonicalSource : undefined
      }),
      previewError: error?.targetKey === targetKey ? error.message : undefined
    };
  }, []);
  const nodeSnapshotStore = useMemo(() => createCanvasPathSnapshotStore({
    deriveSnapshot: deriveNodeSnapshot,
    snapshotsEqual: (left: CanvasVideoPreviewNodeSnapshot, right: CanvasVideoPreviewNodeSnapshot) => (
      sameCanvasRasterPreviewRequest(left.request, right.request)
      && left.previewError === right.previewError
    )
  }), [deriveNodeSnapshot]);

  useLayoutEffect(() => {
    const changedPaths = new Set(changedNodePathsRef.current);
    changedNodePathsRef.current.clear();
    nodeSnapshotStore.flush(changedPaths);
  });

  const value = useMemo<CanvasVideoPreviewRuntimeValue>(() => ({
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

export function canvasVideoRasterPreviewRequest(input: {
  target: CanvasVideoPreviewTarget;
  canonicalSource: {
    canonicalSourceIdentity: CanvasPreviewCanonicalSourceIdentity;
    sourceWidth: number;
  } | undefined;
}): CanvasRasterPreviewRequest {
  const { target, canonicalSource } = input;
  if (!canonicalSource) {
    return {};
  }
  const targetIdentity = canvasVideoPreviewTargetIdentity(target);
  return {
    continuityKey: canvasPreviewContinuityKey({
      mediaKind: 'video',
      projectId: target.projectId,
      canvasId: target.canvasId,
      projectRelativePath: target.projectRelativePath,
      continuityIdentity: `${targetIdentity}\u001f${canonicalSource.canonicalSourceIdentity}`
    }),
    variantTarget: {
      mediaKind: 'video',
      projectId: target.projectId,
      canvasId: target.canvasId,
      projectRelativePath: target.projectRelativePath,
      targetIdentity,
      canonicalSourceIdentity: canonicalSource.canonicalSourceIdentity,
      sourceWidth: canonicalSource.sourceWidth,
      srcForWidth: (width) => canvasVideoPreviewUrl({
        target,
        canonicalSourceIdentity: canonicalSource.canonicalSourceIdentity,
        width
      })
    }
  };
}

export function canvasVideoPreviewTargetsForNodes(input: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
}): CanvasVideoPreviewTarget[] {
  const targets: CanvasVideoPreviewTarget[] = [];
  for (const node of input.nodes) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'video'
      || node.availability.state !== 'available') {
      continue;
    }
    targets.push({
      projectId: canvasRawFileProjectId(node.availability.fileUrl),
      canvasId: input.canvasId,
      projectRelativePath: node.projectRelativePath,
      sourceRevision: node.availability.revision,
      frameTimeMs: node.videoPlayback?.currentTimeMs ?? 0
    });
  }
  return targets;
}

function orderCanvasVideoPreviewTasks(input: {
  tasks: readonly CanvasVideoPreviewTask[];
  nodesByPath: ReadonlyMap<string, ProjectedCanvasNode>;
  visibleRect: CanvasRect;
}): CanvasVideoPreviewTask[] {
  return orderCanvasPreviewItemsByNode({
    items: input.tasks,
    nodesByPath: input.nodesByPath,
    visibleRect: input.visibleRect
  });
}

function canvasVideoPreviewTargetForApi(target: CanvasVideoPreviewTarget): {
  projectRelativePath: string;
  sourceRevision: string;
  frameTimeMs: number;
} {
  return {
    projectRelativePath: target.projectRelativePath,
    sourceRevision: target.sourceRevision,
    frameTimeMs: target.frameTimeMs
  };
}

function isCurrentCanvasVideoPreviewTarget(
  target: CanvasVideoPreviewTarget,
  currentTargetKeys: ReadonlyMap<string, CanvasPreviewTargetKey>
): boolean {
  return currentTargetKeys.get(target.projectRelativePath) === canvasVideoPreviewTargetKey(target);
}

function sameCanvasVideoPreviewTargets(
  left: Readonly<Record<string, CanvasVideoPreviewTarget>>,
  right: Readonly<Record<string, CanvasVideoPreviewTarget>>
): boolean {
  return canvasRecordValuesEqual(left, right, (leftTarget, rightTarget) => (
    canvasVideoPreviewTargetKey(leftTarget) === canvasVideoPreviewTargetKey(rightTarget)
  ));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
