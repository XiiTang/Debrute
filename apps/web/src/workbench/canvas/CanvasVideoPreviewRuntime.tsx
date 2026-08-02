import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasVideoPreviewSourceView } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler.js';
import type { CanvasPreviewOrderSource } from './CanvasRenderLifecycle.js';
import {
  canvasChangedRecordPaths,
  createCanvasPathSnapshotStore
} from './CanvasPathSnapshotStore.js';
import {
  canvasVideoPreviewSource,
  type CanvasVideoPreviewSource
} from './canvasVideoPreviews';
import { orderCanvasPreviewTasks } from './CanvasPreviewScheduling.js';
import { useCanvasPreviewInteractionGate } from './useCanvasPreviewInteractionGate.js';
import type { CanvasRect } from './runtime/canvasGeometry.js';

export interface CanvasVideoPreviewTarget {
  canvasId: string;
  projectRelativePath: string;
  videoRevision: string;
  currentTimeSeconds: number;
}

interface CanvasVideoPreviewPublishedSource {
  targetKey: string;
  sourceKey: string;
  source: CanvasVideoPreviewSource;
}

export interface CanvasVideoPreviewRuntimeValue {
  reportPreviewError(input: {
    projectRelativePath: string;
    preview: CanvasVideoPreviewSource;
    message: string;
  }): void;
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
  const [sourceViews, setSourceViews] = useState<Record<string, CanvasVideoPreviewSourceView>>({});
  const [previewSources, setPreviewSources] = useState<Record<string, CanvasVideoPreviewPublishedSource>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, { targetKey: string; message: string }>>({});
  const currentTargetsRef = useRef(currentTargets);
  const sourceViewsRef = useRef(sourceViews);
  const previewSourcesRef = useRef(previewSources);
  const previewErrorsRef = useRef(previewErrors);
  const changedNodePathsRef = useRef(new Set<string>());
  const checkedTargetKeysRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const sourceRequestRef = useRef<{ readonly targetKeys: ReadonlySet<string> } | undefined>(undefined);
  const previewOrderSnapshot = useSyncExternalStore(
    previewOrder.subscribePreviewOrder,
    previewOrder.getPreviewOrderSnapshot,
    previewOrder.getPreviewOrderSnapshot
  );
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  const previewInputsRef = useRef({
    canvasId,
    nodesByPath,
    resourceZoom,
    devicePixelRatio
  });
  previewInputsRef.current = {
    canvasId,
    nodesByPath,
    resourceZoom,
    devicePixelRatio
  };
  const hasPendingPreviewWork = useCallback(() => {
    if (sourceRequestRef.current) {
      return false;
    }
    return Object.values(currentTargetsRef.current).some((target) => {
      const targetKey = canvasVideoPreviewTargetKey(target);
      if (!checkedTargetKeysRef.current.has(targetKey)) {
        return true;
      }
      const previewInputs = previewInputsRef.current;
      const work = canvasVideoPreviewWorkForTarget({
        target,
        sourceView: sourceViewsRef.current[target.projectRelativePath],
        node: previewInputs.nodesByPath.get(target.projectRelativePath),
        canvasId: previewInputs.canvasId,
        resourceZoom: previewInputs.resourceZoom,
        devicePixelRatio: previewInputs.devicePixelRatio
      });
      if (work.kind === 'error') {
        const error = previewErrorsRef.current[target.projectRelativePath];
        return error?.targetKey !== work.targetKey || error.message !== work.message;
      }
      if (work.kind === 'none') {
        return false;
      }
      const published = previewSourcesRef.current[target.projectRelativePath];
      return published?.targetKey !== work.targetKey || published.sourceKey !== work.resourceKey;
    });
  }, []);
  const {
    interactionActiveRef,
    resumeVersion: interactionResumeVersion
  } = useCanvasPreviewInteractionGate({
    scheduler: previewResourceScheduler,
    hasPendingWork: hasPendingPreviewWork
  });
  const orderedCurrentTargets = useMemo(() => orderCanvasVideoPreviewTargets({
    targets: Object.values(currentTargets),
    nodesByPath,
    visibleRect: previewOrderSnapshot
  }), [currentTargets, nodesByPath, previewOrderSnapshot]);

  currentTargetsRef.current = currentTargets;
  sourceViewsRef.current = sourceViews;
  previewSourcesRef.current = previewSources;
  previewErrorsRef.current = previewErrors;
  const markNodePathChanged = useCallback((path: string) => {
    changedNodePathsRef.current.add(path);
  }, []);
  const markChangedNodeRecords = useCallback(<Value,>(
    previous: Readonly<Record<string, Value>>,
    next: Readonly<Record<string, Value>>
  ) => {
    for (const path of canvasChangedRecordPaths(previous, next)) {
      changedNodePathsRef.current.add(path);
    }
  }, []);

  useEffect(() => {
    const targets = canvasVideoPreviewTargetsForNodes({
      canvasId,
      nodes,
      activeVideoPaths
    });
    if (targets.length === 0) {
      setCurrentTargets((current) => Object.keys(current).length === 0 ? current : {});
      setSourceViews((current) => Object.keys(current).length === 0 ? current : {});
      setPreviewSources((current) => {
        if (Object.keys(current).length === 0) {
          return current;
        }
        markChangedNodeRecords(current, {});
        return {};
      });
      setPreviewErrors((current) => {
        if (Object.keys(current).length === 0) {
          return current;
        }
        markChangedNodeRecords(current, {});
        return {};
      });
      checkedTargetKeysRef.current = new Set();
      currentTargetKeysRef.current = new Map();
      currentResourceKeysRef.current = new Map();
      return;
    }
    const nextTargets = Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
    setCurrentTargets(nextTargets);
    currentTargetKeysRef.current = new Map(targets.map((target) => [
      target.projectRelativePath,
      canvasVideoPreviewTargetKey(target)
    ]));
    checkedTargetKeysRef.current = new Set();
    setSourceViews((current) => canvasVideoPreviewCurrentSourceViews({ targets, sourceViews: current }));
    setPreviewSources((current) => {
      const next = canvasVideoPreviewCurrentSources({ targets, sources: current });
      markChangedNodeRecords(current, next);
      return next;
    });
    setPreviewErrors((current) => {
      const next = clearStaleCanvasVideoPreviewErrors(current, targets);
      markChangedNodeRecords(current, next);
      return next;
    });
  }, [activeVideoPaths, canvasId, markChangedNodeRecords, nodes]);

  useEffect(() => {
    const targets = orderCanvasVideoPreviewTargets({
      targets: Object.values(currentTargets).filter((target) => (
        !checkedTargetKeysRef.current.has(canvasVideoPreviewTargetKey(target))
      )),
      nodesByPath,
      visibleRect: previewOrderSnapshot
    });
    if (sourceRequestRef.current
      || !shouldStartCanvasVideoPreviewSourceWork({
        interactionActive: interactionActiveRef.current,
        pendingSourceCount: targets.length
      })) {
      return undefined;
    }
    const request = {
      targetKeys: new Set(targets.map(canvasVideoPreviewTargetKey))
    };
    sourceRequestRef.current = request;
    void actions.readCanvasVideoPreviewSources({
      canvasId,
      targets: targets.map(({ projectRelativePath, videoRevision, currentTimeSeconds }) => ({
        projectRelativePath,
        videoRevision,
        currentTimeSeconds
      }))
    }).then((result) => {
      if (sourceRequestRef.current !== request) {
        return;
      }
      sourceRequestRef.current = undefined;
      setSourceViews((current) => canvasVideoPreviewSourcesWithViews({
        current,
        targets,
        sources: result.sources
      }));
      const missingTargets = targets.filter((target) => {
        const source = result.sources[target.projectRelativePath];
        return !source
          || source.videoRevision !== target.videoRevision
          || source.currentTimeSeconds !== target.currentTimeSeconds;
      });
      if (missingTargets.length > 0) {
        setPreviewErrors((current) => {
          for (const target of missingTargets) {
            markNodePathChanged(target.projectRelativePath);
          }
          return {
            ...current,
            ...Object.fromEntries(missingTargets.map((target) => [
              target.projectRelativePath,
              {
                targetKey: canvasVideoPreviewTargetKey(target),
                message: `Canvas video preview source response is missing ${target.projectRelativePath}.`
              }
            ]))
          };
        });
      }
      for (const target of targets) {
        checkedTargetKeysRef.current.add(canvasVideoPreviewTargetKey(target));
      }
    }).catch((error: unknown) => {
      if (sourceRequestRef.current !== request) {
        return;
      }
      sourceRequestRef.current = undefined;
      setPreviewErrors((current) => {
        const next = canvasVideoPreviewErrorsForTargets({
          current,
          targets,
          message: messageFromUnknown(error)
        });
        markChangedNodeRecords(current, next);
        return next;
      });
    });
    return undefined;
  }, [actions, canvasId, currentTargets, interactionResumeVersion, markChangedNodeRecords, markNodePathChanged, nodesByPath, previewOrderSnapshot]);

  useEffect(() => {
    const targets = orderedCurrentTargets;
    if (!shouldStartCanvasVideoPreviewSourceWork({
      interactionActive: interactionActiveRef.current,
      pendingSourceCount: targets.length
    })) {
      return;
    }
    for (const target of targets) {
      const work = canvasVideoPreviewWorkForTarget({
        target,
        sourceView: sourceViews[target.projectRelativePath],
        node: nodesByPath.get(target.projectRelativePath),
        canvasId,
        resourceZoom,
        devicePixelRatio
      });
      if (work.kind === 'none') {
        continue;
      }
      if (work.kind === 'error') {
        setPreviewErrors((current) => {
          markNodePathChanged(target.projectRelativePath);
          return {
            ...current,
            [target.projectRelativePath]: { targetKey: work.targetKey, message: work.message }
          };
        });
        continue;
      }
      const published = previewSources[target.projectRelativePath];
      if (published?.targetKey === work.targetKey && published.sourceKey === work.resourceKey) {
        continue;
      }
      currentResourceKeysRef.current.set(target.projectRelativePath, work.resourceKey);
      const publishCurrentSource = () => {
        setPreviewSources((current) => {
          markNodePathChanged(target.projectRelativePath);
          return {
            ...current,
            [target.projectRelativePath]: {
              targetKey: work.targetKey,
              sourceKey: work.resourceKey,
              source: work.preview
            }
          };
        });
        setPreviewErrors((current) => {
          const next = clearCanvasVideoPreviewErrorForPath(current, target.projectRelativePath);
          if (next !== current) {
            markNodePathChanged(target.projectRelativePath);
          }
          return next;
        });
      };
      previewResourceScheduler.enqueue({
        kind: 'video',
        nodeId: target.projectRelativePath,
        sourceKey: work.resourceKey,
        targetWidth: work.preview.previewWidth,
        isCurrent: () => currentTargetKeysRef.current.get(target.projectRelativePath) === work.targetKey
          && currentResourceKeysRef.current.get(target.projectRelativePath) === work.resourceKey
          && !interactionActiveRef.current,
        run: publishCurrentSource
      });
    }
  }, [
    canvasId,
    orderedCurrentTargets,
    devicePixelRatio,
    interactionResumeVersion,
    markNodePathChanged,
    nodesByPath,
    previewResourceScheduler,
    previewSources,
    resourceZoom,
    sourceViews
  ]);

  useEffect(() => () => {
    sourceRequestRef.current = undefined;
    for (const projectRelativePath of currentTargetKeysRef.current.keys()) {
      previewResourceScheduler.cancel('video', projectRelativePath);
    }
  }, [previewResourceScheduler]);

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
      markNodePathChanged(projectRelativePath);
      return {
        ...current,
        [projectRelativePath]: { targetKey, message }
      };
    });
  }, [markNodePathChanged]);

  const reportPreviewErrorRef = useRef(reportPreviewError);
  reportPreviewErrorRef.current = reportPreviewError;
  const deriveNodeSnapshot = useCallback((node: ProjectedCanvasNode): CanvasVideoPreviewNodeSnapshot => {
    const target = currentTargetsRef.current[node.projectRelativePath];
    const published = previewSourcesRef.current[node.projectRelativePath];
    const preview = target && published?.targetKey === canvasVideoPreviewTargetKey(target)
      ? published.source
      : undefined;
    const previewError = previewErrorsRef.current[node.projectRelativePath]?.message;
    return { preview, previewError };
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
    reportPreviewError: (...args) => reportPreviewErrorRef.current(...args),
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
  | { readonly kind: 'error'; readonly targetKey: string; readonly message: string }
  | {
      readonly kind: 'preview';
      readonly targetKey: string;
      readonly resourceKey: string;
      readonly preview: CanvasVideoPreviewSource;
    };

function canvasVideoPreviewWorkForTarget(input: {
  target: CanvasVideoPreviewTarget;
  sourceView: CanvasVideoPreviewSourceView | undefined;
  node: ProjectedCanvasNode | undefined;
  canvasId: string;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasVideoPreviewWork {
  const { target, sourceView, node } = input;
  if (!sourceView
    || !node
    || sourceView.videoRevision !== target.videoRevision
    || sourceView.currentTimeSeconds !== target.currentTimeSeconds) {
    return { kind: 'none' };
  }
  const targetKey = canvasVideoPreviewTargetKey(target);
  if (sourceView.status === 'error') {
    return { kind: 'error', targetKey, message: sourceView.message };
  }
  const preview = canvasVideoPreviewSource({
    canvasId: input.canvasId,
    node,
    sourceKey: sourceView.sourceKey,
    sourceWidth: sourceView.sourceWidth,
    currentTimeSeconds: target.currentTimeSeconds,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  return preview
    ? {
        kind: 'preview',
        targetKey,
        resourceKey: canvasVideoPreviewResourceSourceKey(targetKey, preview.previewWidth, sourceView.sourceKey),
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
      currentTimeSeconds: node.videoPlayback?.currentTimeSeconds ?? 0
    });
  }
  return targets;
}

export function shouldStartCanvasVideoPreviewSourceWork(input: {
  interactionActive: boolean;
  pendingSourceCount: number;
}): boolean {
  return input.pendingSourceCount > 0
    && !input.interactionActive;
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

function canvasVideoPreviewTargetKey(target: CanvasVideoPreviewTarget): string {
  return [
    target.canvasId,
    target.projectRelativePath,
    target.videoRevision,
    String(target.currentTimeSeconds)
  ].join('\u001f');
}

function canvasVideoPreviewResourceSourceKey(targetKey: string, width: number, sourceKey: string): string {
  return `${targetKey}\u001f${sourceKey}\u001f${width}`;
}

function canvasVideoPreviewCurrentSourceViews(input: {
  targets: CanvasVideoPreviewTarget[];
  sourceViews: Record<string, CanvasVideoPreviewSourceView>;
}): Record<string, CanvasVideoPreviewSourceView> {
  const targetKeys = new Map(input.targets.map((target) => [target.projectRelativePath, canvasVideoPreviewTargetKey(target)]));
  return Object.fromEntries(Object.entries(input.sourceViews).filter(([path, source]) => {
    const target = input.targets.find((item) => item.projectRelativePath === path);
    return target && canvasVideoPreviewTargetKey(target) === targetKeys.get(path)
      && source.videoRevision === target.videoRevision
      && source.currentTimeSeconds === target.currentTimeSeconds;
  }));
}

function canvasVideoPreviewCurrentSources(input: {
  targets: CanvasVideoPreviewTarget[];
  sources: Record<string, CanvasVideoPreviewPublishedSource>;
}): Record<string, CanvasVideoPreviewPublishedSource> {
  const currentKeys = new Map(input.targets.map((target) => [target.projectRelativePath, canvasVideoPreviewTargetKey(target)]));
  return Object.fromEntries(Object.entries(input.sources).filter(([path, source]) => currentKeys.get(path) === source.targetKey));
}

function canvasVideoPreviewSourcesWithViews(input: {
  current: Record<string, CanvasVideoPreviewSourceView>;
  targets: CanvasVideoPreviewTarget[];
  sources: Record<string, CanvasVideoPreviewSourceView>;
}): Record<string, CanvasVideoPreviewSourceView> {
  const next = { ...input.current };
  for (const target of input.targets) {
    const source = input.sources[target.projectRelativePath];
    if (source && source.videoRevision === target.videoRevision && source.currentTimeSeconds === target.currentTimeSeconds) {
      next[target.projectRelativePath] = source;
    }
  }
  return next;
}

function canvasVideoPreviewErrorsForTargets(input: {
  current: Record<string, { targetKey: string; message: string }>;
  targets: CanvasVideoPreviewTarget[];
  message: string;
}): Record<string, { targetKey: string; message: string }> {
  return {
    ...input.current,
    ...Object.fromEntries(input.targets.map((target) => [
      target.projectRelativePath,
      { targetKey: canvasVideoPreviewTargetKey(target), message: input.message }
    ]))
  };
}

function clearStaleCanvasVideoPreviewErrors(
  current: Record<string, { targetKey: string; message: string }>,
  targets: CanvasVideoPreviewTarget[]
): Record<string, { targetKey: string; message: string }> {
  const targetKeys = new Map(targets.map((target) => [target.projectRelativePath, canvasVideoPreviewTargetKey(target)]));
  return Object.fromEntries(Object.entries(current).filter(([path, error]) => targetKeys.get(path) === error.targetKey));
}

function clearCanvasVideoPreviewErrorForPath(
  current: Record<string, { targetKey: string; message: string }>,
  projectRelativePath: string
): Record<string, { targetKey: string; message: string }> {
  if (!current[projectRelativePath]) {
    return current;
  }
  const next = { ...current };
  delete next[projectRelativePath];
  return next;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
