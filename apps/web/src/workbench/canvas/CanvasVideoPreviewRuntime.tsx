import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectedCanvasNode } from '@debrute/canvas-core';
import type { CanvasVideoPreviewSourceView } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasCameraState } from './runtime/canvasCamera';
import {
  canvasVideoPreviewSource,
  type CanvasVideoPreviewSource
} from './canvasVideoPreviews';

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
  previewForNode(input: { node: ProjectedCanvasNode }): CanvasVideoPreviewSource | undefined;
  previewErrorForNode(input: { node: ProjectedCanvasNode }): string | undefined;
  reportPreviewError(input: {
    projectRelativePath: string;
    preview: CanvasVideoPreviewSource;
    message: string;
  }): void;
}

const defaultRuntimeValue: CanvasVideoPreviewRuntimeValue = {
  previewForNode: () => undefined,
  previewErrorForNode: () => undefined,
  reportPreviewError: () => {
    throw new Error('Canvas video preview runtime is not available.');
  }
};

const CanvasVideoPreviewRuntimeContext = createContext<CanvasVideoPreviewRuntimeValue>(defaultRuntimeValue);

export function useCanvasVideoPreviewRuntime(): CanvasVideoPreviewRuntimeValue {
  return useContext(CanvasVideoPreviewRuntimeContext);
}

export function CanvasVideoPreviewProvider({
  canvasId,
  nodes,
  activeVideoPaths,
  actions,
  cameraState,
  dragState,
  resourceZoom,
  devicePixelRatio,
  culledNodePaths,
  previewResourceScheduler,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeVideoPaths: ReadonlySet<string>;
  actions: WorkbenchActions;
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  resourceZoom: number;
  devicePixelRatio: number;
  culledNodePaths: ReadonlySet<string>;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasVideoPreviewTarget>>({});
  const [sourceViews, setSourceViews] = useState<Record<string, CanvasVideoPreviewSourceView>>({});
  const [previewSources, setPreviewSources] = useState<Record<string, CanvasVideoPreviewPublishedSource>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<string, { targetKey: string; message: string }>>({});
  const currentTargetsRef = useRef(currentTargets);
  const previewSourcesRef = useRef(previewSources);
  const checkedTargetKeysRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const currentCulledPathsRef = useRef<ReadonlySet<string>>(culledNodePaths);
  const interactionActive = cameraState !== 'idle' || dragState !== undefined;
  const interactionActiveRef = useRef(interactionActive);
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);

  currentCulledPathsRef.current = culledNodePaths;
  currentTargetsRef.current = currentTargets;
  interactionActiveRef.current = interactionActive;
  previewSourcesRef.current = previewSources;

  useEffect(() => {
    const targets = canvasVideoPreviewTargetsForNodes({
      canvasId,
      nodes,
      activeVideoPaths,
      culledNodePaths
    });
    if (targets.length === 0) {
      setCurrentTargets((current) => Object.keys(current).length === 0 ? current : {});
      setSourceViews((current) => Object.keys(current).length === 0 ? current : {});
      setPreviewSources((current) => Object.keys(current).length === 0 ? current : {});
      setPreviewErrors((current) => Object.keys(current).length === 0 ? current : {});
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
    setPreviewSources((current) => canvasVideoPreviewCurrentSources({ targets, sources: current }));
    setPreviewErrors((current) => clearStaleCanvasVideoPreviewErrors(current, targets));
  }, [activeVideoPaths, canvasId, culledNodePaths, nodes]);

  useEffect(() => {
    const targets = Object.values(currentTargets).filter((target) => !checkedTargetKeysRef.current.has(canvasVideoPreviewTargetKey(target)));
    if (!shouldStartCanvasVideoPreviewSourceWork({ cameraState, dragState, pendingSourceCount: targets.length })) {
      return undefined;
    }
    let cancelled = false;
    void actions.readCanvasVideoPreviewSources({
      canvasId,
      targets: targets.map(({ projectRelativePath, videoRevision, currentTimeSeconds }) => ({
        projectRelativePath,
        videoRevision,
        currentTimeSeconds
      }))
    }).then((result) => {
      if (cancelled) {
        return;
      }
      setSourceViews((current) => canvasVideoPreviewSourcesWithViews({
        current,
        targets,
        sources: result.sources
      }));
      for (const target of targets) {
        checkedTargetKeysRef.current.add(canvasVideoPreviewTargetKey(target));
      }
    }).catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      setPreviewErrors((current) => canvasVideoPreviewErrorsForTargets({
        current,
        targets,
        message: messageFromUnknown(error)
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [actions, cameraState, canvasId, currentTargets, dragState]);

  useEffect(() => {
    const targets = Object.values(currentTargets);
    if (!shouldStartCanvasVideoPreviewSourceWork({ cameraState, dragState, pendingSourceCount: targets.length })) {
      return;
    }
    for (const target of targets) {
      const node = nodesByPath.get(target.projectRelativePath);
      if (!node) {
        continue;
      }
      const targetKey = canvasVideoPreviewTargetKey(target);
      const source = sourceViews[target.projectRelativePath];
      if (!source || source.currentTimeSeconds !== target.currentTimeSeconds || source.videoRevision !== target.videoRevision) {
        continue;
      }
      if (source.status === 'error') {
        setPreviewErrors((current) => ({
          ...current,
          [target.projectRelativePath]: { targetKey, message: source.message }
        }));
        continue;
      }
      const preview = canvasVideoPreviewSource({
        canvasId,
        node,
        sourceKey: source.sourceKey,
        sourceWidth: source.sourceWidth,
        currentTimeSeconds: target.currentTimeSeconds,
        resourceZoom,
        devicePixelRatio
      });
      if (!preview) {
        continue;
      }
      const resourceKey = canvasVideoPreviewResourceSourceKey(targetKey, preview.previewWidth, source.sourceKey);
      const published = previewSources[target.projectRelativePath];
      if (published?.targetKey === targetKey && published.sourceKey === resourceKey) {
        continue;
      }
      currentResourceKeysRef.current.set(target.projectRelativePath, resourceKey);
      const publishCurrentSource = () => {
        setPreviewSources((current) => ({
          ...current,
          [target.projectRelativePath]: {
            targetKey,
            sourceKey: resourceKey,
            source: preview
          }
        }));
        setPreviewErrors((current) => clearCanvasVideoPreviewErrorForPath(current, target.projectRelativePath));
      };
      const hasCurrentSourcePreview = published?.targetKey === targetKey;
      if (!hasCurrentSourcePreview && !currentCulledPathsRef.current.has(target.projectRelativePath)) {
        publishCurrentSource();
        continue;
      }
      previewResourceScheduler.enqueue({
        kind: 'video',
        nodeId: target.projectRelativePath,
        sourceKey: resourceKey,
        targetWidth: preview.previewWidth,
        isCurrent: () => currentTargetKeysRef.current.get(target.projectRelativePath) === targetKey
          && currentResourceKeysRef.current.get(target.projectRelativePath) === resourceKey
          && !interactionActiveRef.current,
        isCulled: () => currentCulledPathsRef.current.has(target.projectRelativePath),
        run: publishCurrentSource
      });
    }
  }, [
    cameraState,
    canvasId,
    currentTargets,
    devicePixelRatio,
    dragState,
    nodesByPath,
    previewResourceScheduler,
    previewSources,
    resourceZoom,
    sourceViews
  ]);

  useEffect(() => () => {
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
      return {
        ...current,
        [projectRelativePath]: { targetKey, message }
      };
    });
  }, []);

  const value = useMemo<CanvasVideoPreviewRuntimeValue>(() => ({
    previewForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const published = previewSources[node.projectRelativePath];
      return target && published?.targetKey === canvasVideoPreviewTargetKey(target)
        ? published.source
        : undefined;
    },
    previewErrorForNode: ({ node }) => previewErrors[node.projectRelativePath]?.message,
    reportPreviewError
  }), [currentTargets, previewErrors, previewSources, reportPreviewError]);

  return (
    <CanvasVideoPreviewRuntimeContext.Provider value={value}>
      {children}
    </CanvasVideoPreviewRuntimeContext.Provider>
  );
}

export function canvasVideoPreviewTargetsForNodes(input: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  activeVideoPaths: ReadonlySet<string>;
  culledNodePaths: ReadonlySet<string>;
}): CanvasVideoPreviewTarget[] {
  const targets: CanvasVideoPreviewTarget[] = [];
  for (const node of input.nodes) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'video'
      || node.availability.state !== 'available'
      || input.activeVideoPaths.has(node.projectRelativePath)
      || input.culledNodePaths.has(node.projectRelativePath)) {
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
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  pendingSourceCount: number;
}): boolean {
  return input.pendingSourceCount > 0
    && input.cameraState === 'idle'
    && input.dragState === undefined;
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
