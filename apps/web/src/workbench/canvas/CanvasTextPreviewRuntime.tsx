import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  canvasRasterPreviewWidth,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextEditor } from './CanvasTextEditor';
import {
  CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
  captureCanvasTextPreviewSource,
  canvasTextPreviewFingerprint
} from './CanvasTextPreviewCapture';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasCameraState } from './runtime/canvasCamera';
import {
  canvasTextPreviewStyleKey,
  canvasTextPreviewStyleSnapshotForDocument,
  type CanvasTextPreviewStyleKey
} from './CanvasTextPreviewStyleKey';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor';

const CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY = 3;
const CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_TOP_TOLERANCE_PX = 0.5;
const CANVAS_TEXT_PREVIEW_CAPTURE_SCROLLER_ERROR = 'Canvas text preview capture target is missing CodeMirror scroller.';

export interface CanvasTextPreviewSource {
  src: string;
  previewWidth: number;
  fingerprint: string;
}

export type CanvasLoadedTextPreviewSource = CanvasTextPreviewSource & {
  loadKey: string;
};

export interface CanvasTextPreviewImageState {
  loaded?: CanvasLoadedTextPreviewSource | undefined;
  next?: CanvasLoadedTextPreviewSource | undefined;
}

export type CanvasTextPreviewImageEvent =
  | { type: 'source-resolved'; source: CanvasTextPreviewSource | undefined }
  | { type: 'source-invalidated' }
  | { type: 'next-loaded'; loadKey: string }
  | { type: 'next-failed'; loadKey: string }
  | { type: 'interaction-started' };

export interface CanvasTextPreviewMeasuredBody {
  width: number;
  height: number;
}

export interface CanvasTextPreviewCandidate {
  canvasId: string;
  projectRelativePath: string;
  content: string;
  language: ProjectTextLanguageId;
  wordWrap: boolean;
  contentCssWidth: number;
  contentCssHeight: number;
  scrollTop: number;
  scrollLeft: number;
  styleKey: string;
}

export interface CanvasTextPreviewTarget extends CanvasTextPreviewCandidate {
  fingerprint: string;
}

interface CanvasTextPreviewPublishedSource {
  targetKey: string;
  sourceKey: string;
  source: CanvasTextPreviewSource;
}

interface CanvasTextPreviewSourceAvailability {
  fingerprint: string;
  available: boolean;
}

export interface CanvasTextPreviewRuntimeValue {
  registerTextBody(projectRelativePath: string, element: HTMLElement | null): void;
  previewForNode(input: {
    node: ProjectedCanvasNode;
  }): CanvasTextPreviewSource | undefined;
  previewErrorForNode(input: {
    node: ProjectedCanvasNode;
  }): string | undefined;
}

const defaultRuntimeValue: CanvasTextPreviewRuntimeValue = {
  registerTextBody: () => undefined,
  previewForNode: () => undefined,
  previewErrorForNode: () => undefined
};

const CanvasTextPreviewRuntimeContext = createContext<CanvasTextPreviewRuntimeValue>(defaultRuntimeValue);

export function useCanvasTextPreviewRuntime(): CanvasTextPreviewRuntimeValue {
  return useContext(CanvasTextPreviewRuntimeContext);
}

export function initialCanvasTextPreviewImageState(
  source?: CanvasTextPreviewSource | undefined
): CanvasTextPreviewImageState {
  return source
    ? { loaded: canvasLoadedTextPreviewSource(source), next: undefined }
    : { loaded: undefined, next: undefined };
}

export function canvasTextPreviewImageReducer(
  state: CanvasTextPreviewImageState,
  event: CanvasTextPreviewImageEvent
): CanvasTextPreviewImageState {
  switch (event.type) {
    case 'source-resolved': {
      if (!event.source) {
        return state.next ? { ...state, next: undefined } : state;
      }
      const next = canvasLoadedTextPreviewSource(event.source);
      if (!state.loaded) {
        return { loaded: next, next: undefined };
      }
      if (state.loaded?.loadKey === next.loadKey) {
        return state.next ? { ...state, next: undefined } : state;
      }
      if (state.next?.loadKey === next.loadKey) {
        return state;
      }
      return {
        ...state,
        next
      };
    }
    case 'source-invalidated':
      return state.loaded || state.next ? initialCanvasTextPreviewImageState() : state;
    case 'next-loaded':
      if (!state.next || state.next.loadKey !== event.loadKey) {
        return state;
      }
      return {
        loaded: state.next,
        next: undefined
      };
    case 'next-failed':
      if (!state.next || state.next.loadKey !== event.loadKey) {
        return state;
      }
      return {
        ...state,
        next: undefined
      };
    case 'interaction-started':
      if (!state.loaded || !state.next) {
        return state;
      }
      return {
        ...state,
        next: undefined
      };
  }
}

function canvasLoadedTextPreviewSource(source: CanvasTextPreviewSource): CanvasLoadedTextPreviewSource {
  return {
    ...source,
    loadKey: source.src
  };
}

export function CanvasTextPreviewProvider({
  canvasId,
  nodes,
  selectedProjectRelativePaths,
  textFileBuffers,
  actions,
  cameraState,
  dragState,
  resourceZoom,
  devicePixelRatio,
  culledNodePaths,
  previewResourceScheduler,
  styleDependencyKey,
  perfMonitor,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  selectedProjectRelativePaths: readonly string[];
  textFileBuffers: Record<string, TextFileBuffer>;
  actions: WorkbenchActions;
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  resourceZoom: number;
  devicePixelRatio: number;
  culledNodePaths: ReadonlySet<string>;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  styleDependencyKey: string;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  children: React.ReactNode;
}): React.ReactElement {
  const [sourceAvailability, setSourceAvailability] = useState<Record<string, CanvasTextPreviewSourceAvailability>>({});
  const [measuredBodies, setMeasuredBodies] = useState<Map<string, CanvasTextPreviewMeasuredBody>>(() => new Map());
  const [captureTargets, setCaptureTargets] = useState<CanvasTextPreviewTarget[]>([]);
  const [captureLayerRoot, setCaptureLayerRoot] = useState<HTMLElement | undefined>();
  const [captureSlotVersion, setCaptureSlotVersion] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, { captureKey: string; message: string }>>({});
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasTextPreviewTarget>>({});
  const [previewSources, setPreviewSources] = useState<Record<string, CanvasTextPreviewPublishedSource>>({});
  const [availabilityCheckedTargetKeys, setAvailabilityCheckedTargetKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [styleKeyState, setStyleKeyState] = useState<{
    key?: CanvasTextPreviewStyleKey | undefined;
    error?: Error | undefined;
  }>({});
  const pendingCaptureKeysRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const currentResourceKeysRef = useRef(new Map<string, string>());
  const currentCulledPathsRef = useRef<ReadonlySet<string>>(culledNodePaths);
  const interactionActive = cameraState !== 'idle' || dragState !== undefined;
  const interactionActiveRef = useRef(interactionActive);
  const bodyRegistrationsRef = useRef(new Map<string, () => void>());
  currentCulledPathsRef.current = culledNodePaths;
  interactionActiveRef.current = interactionActive;
  const nodesByPath = useMemo(() => new Map(nodes.map((node) => [node.projectRelativePath, node])), [nodes]);
  const recordTextPreviewCounter = useCallback((
    name: CanvasPerfCounterName,
    detail?: Record<string, unknown>
  ) => {
    perfMonitor?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: performance.now(),
      source: 'CanvasTextPreviewRuntime',
      name,
      detail
    });
  }, [perfMonitor]);

  useEffect(() => {
    setCaptureLayerRoot(document.body);
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const snapshot = canvasTextPreviewStyleSnapshotForDocument();
      void canvasTextPreviewStyleKey(snapshot).then((key) => {
        if (!cancelled) {
          setStyleKeyState((current) => current.key === key && !current.error ? current : { key });
        }
      }).catch((error: unknown) => {
        if (!cancelled) {
          setStyleKeyState({ error: errorFromUnknown(error) });
        }
      });
    } catch (error: unknown) {
      setStyleKeyState({ error: errorFromUnknown(error) });
    }
    return () => {
      cancelled = true;
    };
  }, [styleDependencyKey]);

  if (styleKeyState.error) {
    throw styleKeyState.error;
  }

  const commitTextBodyMeasurement = useCallback((projectRelativePath: string, element: HTMLElement) => {
    setMeasuredBodies((current) => {
      const next = new Map(current);
      const measurement = canvasTextPreviewBodyMeasurement(element);
      const existing = current.get(projectRelativePath);
      if (existing
        && existing.width === measurement.width
        && existing.height === measurement.height) {
        return current;
      }
      next.set(projectRelativePath, measurement);
      return next;
    });
  }, []);

  const registerTextBody = useCallback((projectRelativePath: string, element: HTMLElement | null) => {
    bodyRegistrationsRef.current.get(projectRelativePath)?.();
    bodyRegistrationsRef.current.delete(projectRelativePath);
    if (!element) {
      return;
    }

    const commit = () => commitTextBodyMeasurement(projectRelativePath, element);
    const cleanup: Array<() => void> = [];

    if (typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(commit);
      resizeObserver.observe(element);
      cleanup.push(() => resizeObserver.disconnect());
    }

    if (typeof window !== 'undefined') {
      const frame = window.requestAnimationFrame(commit);
      cleanup.push(() => window.cancelAnimationFrame(frame));
    }

    commit();
    bodyRegistrationsRef.current.set(projectRelativePath, () => {
      for (const item of cleanup) {
        item();
      }
    });
  }, [commitTextBodyMeasurement]);

  useEffect(() => {
    let cancelled = false;
    if (!styleKeyState.key) {
      return undefined;
    }
    const candidates = canvasTextPreviewTargetsForNodes({
      canvasId,
      nodes,
      selectedProjectRelativePaths,
      textFileBuffers,
      measuredBodies,
      culledNodePaths,
      styleKey: styleKeyState.key
    });
    if (candidates.length === 0) {
      setCurrentTargets((current) => Object.keys(current).length === 0 ? current : {});
      currentTargetKeysRef.current = new Map();
      currentResourceKeysRef.current = new Map();
      setAvailabilityCheckedTargetKeys((current) => current.size === 0 ? current : new Set());
      setSourceAvailability((current) => Object.keys(current).length === 0 ? current : {});
      setPreviewSources((current) => Object.keys(current).length === 0 ? current : {});
      setPreviewErrors((current) => Object.keys(current).length === 0 ? current : {});
      return undefined;
    }
    if (!shouldStartCanvasTextPreviewSourceWork({
      cameraState,
      dragState,
      pendingSourceCount: candidates.length
    })) {
      return undefined;
    }
    void Promise.all(candidates.map(async (candidate): Promise<CanvasTextPreviewTarget> => ({
      ...candidate,
      fingerprint: await canvasTextPreviewFingerprint(candidate)
    }))).then(async (targets) => {
      if (cancelled || targets.length === 0) {
        return;
      }
      const targetKeySet = new Set(targets.map(canvasTextPreviewTargetKey));
      for (const pendingKey of pendingCaptureKeysRef.current) {
        if (!targetKeySet.has(pendingKey)) {
          pendingCaptureKeysRef.current.delete(pendingKey);
        }
      }
      setCurrentTargets(canvasTextPreviewTargetsByPath(targets));
      currentTargetKeysRef.current = new Map(targets.map((target) => [
        target.projectRelativePath,
        canvasTextPreviewTargetKey(target)
      ]));
      setAvailabilityCheckedTargetKeys((current) => new Set([...current].filter((key) => targetKeySet.has(key))));
      setSourceAvailability((current) => canvasTextPreviewCurrentSourceAvailability({ targets, sourceAvailability: current }));
      setPreviewSources((current) => canvasTextPreviewCurrentSources({ targets, sources: current }));
      setPreviewErrors((current) => clearStaleCanvasTextPreviewErrors(current, targets));
    });
    return () => {
      cancelled = true;
    };
  }, [
    cameraState,
    canvasId,
    culledNodePaths,
    dragState,
    measuredBodies,
    nodes,
    selectedProjectRelativePaths,
    styleKeyState.key,
    textFileBuffers
  ]);

  useEffect(() => {
    const targets = Object.values(currentTargets).filter((target) => (
      !availabilityCheckedTargetKeys.has(canvasTextPreviewTargetKey(target))
    ));
    if (!shouldStartCanvasTextPreviewSourceWork({
      cameraState,
      dragState,
      pendingSourceCount: targets.length
    })) {
      return undefined;
    }
    let cancelled = false;
    recordTextPreviewCounter('text-preview-source-check-requested', {
      count: targets.length
    });
    void actions.readCanvasTextPreviewSources({
      canvasId,
      sources: targets.map(canvasTextPreviewSourceTargetForApi)
    }).then((result) => {
      if (cancelled) {
        return;
      }
      for (const target of targets) {
        const source = result.sources[target.projectRelativePath];
        recordTextPreviewCounter('text-preview-source-availability-resolved', {
          projectRelativePath: target.projectRelativePath,
          fingerprint: target.fingerprint,
          available: Boolean(source && source.fingerprint === target.fingerprint && source.available)
        });
      }
      setSourceAvailability((current) => canvasTextPreviewSourcesWithAvailability({
        current,
        targets,
        sources: result.sources
      }));
      setAvailabilityCheckedTargetKeys((current) => new Set([
        ...current,
        ...targets.map(canvasTextPreviewTargetKey)
      ]));
    }).catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      setPreviewErrors((current) => canvasTextPreviewErrorsForTargets({
        current,
        targets,
        message: messageFromUnknown(error)
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [
    actions,
    availabilityCheckedTargetKeys,
    cameraState,
    canvasId,
    currentTargets,
    dragState,
    recordTextPreviewCounter
  ]);

  useEffect(() => {
    const targets = Object.values(currentTargets);
    if (!shouldStartCanvasTextPreviewSourceWork({
      cameraState,
      dragState,
      pendingSourceCount: targets.length
    })) {
      return;
    }
    for (const target of targets) {
      const node = nodesByPath.get(target.projectRelativePath);
      if (!node) {
        continue;
      }
      const targetKey = canvasTextPreviewTargetKey(target);
      const availability = sourceAvailability[target.projectRelativePath];
      if (!availability || availability.fingerprint !== target.fingerprint || !availability.available) {
        continue;
      }
      const targetWidth = canvasTextPreviewTargetWidthForNode({
        node,
        target,
        resourceZoom,
        devicePixelRatio
      });
      const sourceKey = canvasTextPreviewResourceSourceKey(targetKey, targetWidth);
      const published = previewSources[target.projectRelativePath];
      if (published?.targetKey === targetKey && published.sourceKey === sourceKey) {
        continue;
      }
      currentResourceKeysRef.current.set(target.projectRelativePath, sourceKey);

      const publishCurrentSource = () => {
        setPreviewSources((current) => canvasTextPreviewSourcesWithTargetSource({
          current,
          node,
          canvasId,
          target,
          targetKey,
          resourceZoom,
          devicePixelRatio
        }));
      };

      const hasCurrentSourcePreview = published?.targetKey === targetKey;
      if (!hasCurrentSourcePreview && !currentCulledPathsRef.current.has(target.projectRelativePath)) {
        recordTextPreviewCounter('text-preview-publish-critical', {
          projectRelativePath: target.projectRelativePath,
          targetWidth
        });
        publishCurrentSource();
        continue;
      }

      previewResourceScheduler.enqueue({
        kind: 'text',
        nodeId: target.projectRelativePath,
        sourceKey,
        targetWidth,
        isCurrent: () => currentTargetKeysRef.current.get(target.projectRelativePath) === targetKey
          && currentResourceKeysRef.current.get(target.projectRelativePath) === sourceKey
          && !interactionActiveRef.current,
        isCulled: () => currentCulledPathsRef.current.has(target.projectRelativePath),
        run: () => {
          const isCurrent = () => currentTargetKeysRef.current.get(target.projectRelativePath) === targetKey
            && currentResourceKeysRef.current.get(target.projectRelativePath) === sourceKey
            && !interactionActiveRef.current;
          if (!isCurrent()) {
            return;
          }
          recordTextPreviewCounter('text-preview-publish-deferred', {
            projectRelativePath: target.projectRelativePath,
            targetWidth
          });
          publishCurrentSource();
        }
      });
    }
  }, [
    cameraState,
    canvasId,
    currentTargets,
    devicePixelRatio,
    dragState,
    resourceZoom,
    nodesByPath,
    previewSources,
    previewResourceScheduler,
    recordTextPreviewCounter,
    sourceAvailability
  ]);

  useEffect(() => () => {
    for (const projectRelativePath of currentTargetKeysRef.current.keys()) {
      previewResourceScheduler.cancel('text-source', projectRelativePath);
      previewResourceScheduler.cancel('text', projectRelativePath);
    }
  }, [previewResourceScheduler]);

  useEffect(() => {
    if (!interactionActive) {
      return;
    }
    pendingCaptureKeysRef.current.clear();
    setCaptureTargets((current) => current.length === 0 ? current : []);
  }, [interactionActive]);

  useEffect(() => {
    const targets = Object.values(currentTargets).filter((target) => (
      availabilityCheckedTargetKeys.has(canvasTextPreviewTargetKey(target))
    ));
    if (!shouldStartCanvasTextPreviewSourceWork({
      cameraState,
      dragState,
      pendingSourceCount: targets.length
    })) {
      return;
    }
    const failedCaptureKeys = new Set(Object.values(previewErrors).map((error) => error.captureKey));
    const nextCaptures = canvasTextPreviewNextCaptureTargets({
      targets,
      sourceAvailability,
      pendingCaptureKeys: pendingCaptureKeysRef.current,
      skippedCaptureKeys: failedCaptureKeys,
      concurrency: CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY
    });
    for (const target of nextCaptures) {
      const targetKey = canvasTextPreviewTargetKey(target);
      previewResourceScheduler.enqueue({
        kind: 'text-source',
        nodeId: target.projectRelativePath,
        sourceKey: targetKey,
        targetWidth: Math.ceil(target.contentCssWidth * CANVAS_TEXT_PREVIEW_SOURCE_SCALE),
        isCurrent: () => pendingCaptureKeysRef.current.has(targetKey),
        isCulled: () => false,
        run: () => {
          if (!pendingCaptureKeysRef.current.has(targetKey)
            || currentTargetKeysRef.current.get(target.projectRelativePath) !== targetKey
            || interactionActiveRef.current
            || currentCulledPathsRef.current.has(target.projectRelativePath)) {
            pendingCaptureKeysRef.current.delete(targetKey);
            setCaptureSlotVersion((current) => current + 1);
            return;
          }
          setCaptureTargets((current) => current.some((item) => canvasTextPreviewTargetKey(item) === targetKey)
            ? current
            : [...current, target]);
        }
      });
    }
  }, [
    cameraState,
    captureSlotVersion,
    currentTargets,
    dragState,
    previewErrors,
    availabilityCheckedTargetKeys,
    previewResourceScheduler,
    sourceAvailability
  ]);

  const finishCaptureTarget = useCallback((target: CanvasTextPreviewTarget, result: CanvasTextPreviewCaptureResult) => {
    const key = canvasTextPreviewTargetKey(target);
    pendingCaptureKeysRef.current.delete(key);
    setCaptureTargets((current) => current.filter((item) => canvasTextPreviewTargetKey(item) !== key));
    setCaptureSlotVersion((current) => current + 1);
    if (currentTargetKeysRef.current.get(target.projectRelativePath) !== key) {
      return;
    }
    if (result.status === 'ok') {
      recordTextPreviewCounter('text-preview-source-capture-saved', {
        projectRelativePath: target.projectRelativePath,
        fingerprint: target.fingerprint
      });
      setSourceAvailability((current) => ({
        ...current,
        [target.projectRelativePath]: {
          fingerprint: target.fingerprint,
          available: true
        }
      }));
      setPreviewErrors((current) => clearCanvasTextPreviewErrorForPath(current, target.projectRelativePath));
      return;
    }
    setPreviewErrors((current) => ({
      ...current,
      [target.projectRelativePath]: {
        captureKey: key,
        message: result.message
      }
    }));
  }, [recordTextPreviewCounter]);

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    registerTextBody,
    previewForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const published = previewSources[node.projectRelativePath];
      return target && published?.targetKey === canvasTextPreviewTargetKey(target)
        ? published.source
        : undefined;
    },
    previewErrorForNode: ({ node }) => previewErrors[node.projectRelativePath]?.message
  }), [currentTargets, previewErrors, previewSources, registerTextBody]);

  const captureLayer = (
    <div className="canvas-text-preview-capture-layer" aria-hidden="true">
      {captureTargets.map((target) => (
        <CanvasTextPreviewCaptureTarget
          key={canvasTextPreviewTargetKey(target)}
          target={target}
          actions={actions}
          onComplete={finishCaptureTarget}
        />
      ))}
    </div>
  );

  return (
    <CanvasTextPreviewRuntimeContext.Provider value={value}>
      {children}
      {captureLayerRoot ? createPortal(captureLayer, captureLayerRoot) : null}
    </CanvasTextPreviewRuntimeContext.Provider>
  );
}

export function canvasTextPreviewTargetsForNodes(input: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  selectedProjectRelativePaths: readonly string[];
  textFileBuffers: Record<string, TextFileBuffer>;
  measuredBodies: Map<string, CanvasTextPreviewMeasuredBody>;
  culledNodePaths: ReadonlySet<string>;
  styleKey: string;
}): CanvasTextPreviewCandidate[] {
  const selected = new Set(input.selectedProjectRelativePaths);
  const targets: CanvasTextPreviewCandidate[] = [];
  for (const node of [...input.nodes].sort(compareCanvasTextPreviewNodeOrder)) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'text'
      || node.availability.state !== 'available'
      || input.culledNodePaths.has(node.projectRelativePath)
      || selected.has(node.projectRelativePath)) {
      continue;
    }
    const buffer = input.textFileBuffers[node.projectRelativePath];
    const measured = input.measuredBodies.get(node.projectRelativePath);
    if (!buffer || buffer.error || !measured || measured.width <= 0 || measured.height <= 0) {
      continue;
    }
    targets.push({
      canvasId: input.canvasId,
      projectRelativePath: node.projectRelativePath,
      content: buffer.content,
      language: buffer.language,
      wordWrap: buffer.wordWrap,
      contentCssWidth: measured.width,
      contentCssHeight: measured.height,
      scrollTop: node.textViewport?.scrollTop ?? 0,
      scrollLeft: node.textViewport?.scrollLeft ?? 0,
      styleKey: input.styleKey
    });
  }
  return targets;
}

function compareCanvasTextPreviewNodeOrder(left: ProjectedCanvasNode, right: ProjectedCanvasNode): number {
  return left.y - right.y
    || left.x - right.x
    || left.projectRelativePath.localeCompare(right.projectRelativePath);
}

export function shouldStartCanvasTextPreviewSourceWork(input: {
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  pendingSourceCount: number;
}): boolean {
  return input.pendingSourceCount > 0
    && input.cameraState === 'idle'
    && input.dragState === undefined;
}

export function isCanvasTextPreviewCaptureLayoutReady(element: HTMLElement): boolean {
  const scroller = element.querySelector('.cm-scroller');
  if (!(scroller instanceof HTMLElement)) {
    return false;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const firstLine = firstVisibleCanvasTextPreviewElement(
    element.querySelectorAll('.cm-content .cm-line'),
    scroller,
    scrollerRect
  );
  const firstLineNumber = firstVisibleCanvasTextPreviewElement(
    element.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    scroller,
    scrollerRect
  );
  if (!firstLine || !firstLineNumber) {
    return false;
  }
  const lineBox = canvasTextPreviewViewportBox(firstLine, scrollerRect);
  const lineNumberBox = canvasTextPreviewViewportBox(firstLineNumber, scrollerRect);
  return canvasTextPreviewGutterTopOffset(element, lineBox, lineNumberBox) !== undefined;
}

export function prepareCanvasTextPreviewCaptureElement(element: HTMLElement): void {
  const scroller = element.querySelector('.cm-scroller');
  if (!(scroller instanceof HTMLElement)) {
    throw new Error(CANVAS_TEXT_PREVIEW_CAPTURE_SCROLLER_ERROR);
  }
  const firstLine = firstMeasuredCanvasTextPreviewElement(element.querySelectorAll('.cm-content .cm-line'));
  if (!firstLine) {
    return;
  }
  const lineStyle = window.getComputedStyle(firstLine);
  for (const gutterElement of element.querySelectorAll('.cm-gutterElement')) {
    if (!(gutterElement instanceof HTMLElement) || !isMeasuredCanvasTextPreviewElement(gutterElement)) {
      continue;
    }
    inlineCanvasTextPreviewCaptureProperties(gutterElement, lineStyle, [
      'font-family',
      'font-size',
      'font-weight',
      'font-variant-numeric',
      'line-height'
    ]);
    inlineCanvasTextPreviewCaptureProperties(gutterElement, window.getComputedStyle(gutterElement), [
      'box-sizing',
      'height',
      'margin-top',
      'padding-left',
      'padding-right',
      'text-align',
      'white-space'
    ]);
    gutterElement.style.minHeight = lineStyle.lineHeight;
  }
  materializeCanvasTextPreviewCaptureViewport(element, scroller);
}

export async function waitForCanvasTextPreviewCaptureLayout(
  element: HTMLElement,
  options: {
    isCancelled?: (() => boolean) | undefined;
  } = {}
): Promise<boolean> {
  await canvasTextPreviewFontsReady();
  while (!options.isCancelled?.()) {
    if (isCanvasTextPreviewCaptureLayoutReady(element)) {
      return true;
    }
    await canvasTextPreviewAnimationFrame();
  }
  return false;
}

function firstMeasuredCanvasTextPreviewElement(elements: NodeListOf<Element>): HTMLElement | undefined {
  for (const element of elements) {
    if (element instanceof HTMLElement && isMeasuredCanvasTextPreviewElement(element)) {
      return element;
    }
  }
  return undefined;
}

function firstVisibleCanvasTextPreviewElement(
  elements: NodeListOf<Element>,
  scroller: HTMLElement,
  scrollerRect: DOMRect
): HTMLElement | undefined {
  for (const element of elements) {
    if (element instanceof HTMLElement
      && isMeasuredCanvasTextPreviewElement(element)
      && canvasTextPreviewBoxIntersectsScroller(element, scroller, scrollerRect)) {
      return element;
    }
  }
  return undefined;
}

function isMeasuredCanvasTextPreviewElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  return Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0;
}

function inlineCanvasTextPreviewCaptureProperties(
  element: HTMLElement,
  style: CSSStyleDeclaration,
  properties: string[]
): void {
  for (const property of properties) {
    const value = style.getPropertyValue(property);
    if (value) {
      element.style.setProperty(property, value, style.getPropertyPriority(property));
    }
  }
}

function materializeCanvasTextPreviewCaptureViewport(
  element: HTMLElement,
  scroller: HTMLElement
): void {
  for (const existing of scroller.querySelectorAll('.canvas-text-preview-static-viewport')) {
    existing.remove();
  }
  scroller.style.overflow = 'hidden';
  scroller.style.position = 'relative';
  const scrollerRect = scroller.getBoundingClientRect();
  const staticViewport = document.createElement('div');
  staticViewport.className = 'canvas-text-preview-static-viewport';
  staticViewport.style.position = 'absolute';
  staticViewport.style.inset = '0';
  staticViewport.style.overflow = 'hidden';
  staticViewport.style.pointerEvents = 'none';

  const staticGutter = document.createElement('div');
  staticGutter.className = 'cm-lineNumbers canvas-text-preview-static-line-numbers';
  staticGutter.style.position = 'absolute';
  staticGutter.style.inset = '0';
  staticViewport.append(staticGutter);

  const staticContent = document.createElement('div');
  staticContent.className = 'cm-content canvas-text-preview-static-content';
  staticContent.style.position = 'absolute';
  staticContent.style.inset = '0';
  staticContent.style.padding = '0';
  staticContent.style.minHeight = '0';
  staticViewport.append(staticContent);

  const firstLine = firstVisibleCanvasTextPreviewElement(
    element.querySelectorAll('.cm-content .cm-line'),
    scroller,
    scrollerRect
  );
  const firstLineNumber = firstVisibleCanvasTextPreviewElement(
    element.querySelectorAll('.cm-lineNumbers .cm-gutterElement'),
    scroller,
    scrollerRect
  );
  const gutterTopOffset = firstLine && firstLineNumber
    ? canvasTextPreviewGutterTopOffset(
      element,
      canvasTextPreviewViewportBox(firstLine, scrollerRect),
      canvasTextPreviewViewportBox(firstLineNumber, scrollerRect)
    ) ?? 0
    : 0;
  for (const gutterElement of element.querySelectorAll('.cm-lineNumbers .cm-gutterElement')) {
    if (gutterElement instanceof HTMLElement
      && canvasTextPreviewBoxIntersectsScroller(gutterElement, scroller, scrollerRect)) {
      staticGutter.append(cloneCanvasTextPreviewVisibleElement(
        gutterElement,
        scrollerRect,
        gutterTopOffset
      ));
    }
  }
  for (const line of element.querySelectorAll('.cm-content .cm-line')) {
    if (line instanceof HTMLElement
      && canvasTextPreviewBoxIntersectsScroller(line, scroller, scrollerRect)) {
      staticContent.append(cloneCanvasTextPreviewVisibleElement(line, scrollerRect));
    }
  }

  for (const content of element.querySelectorAll('.cm-content')) {
    if (content instanceof HTMLElement) {
      content.style.display = 'none';
    }
  }
  for (const gutter of element.querySelectorAll('.cm-gutters, .cm-gutter')) {
    if (gutter instanceof HTMLElement) {
      gutter.style.display = 'none';
    }
  }
  scroller.append(staticViewport);
  scroller.scrollTop = 0;
  scroller.scrollLeft = 0;
}

function canvasTextPreviewContentPaddingTop(element: HTMLElement): number {
  const content = element.querySelector('.cm-content');
  if (!(content instanceof HTMLElement)) {
    return 0;
  }
  const paddingTop = parseFloat(window.getComputedStyle(content).paddingTop);
  return Number.isFinite(paddingTop) ? paddingTop : 0;
}

function canvasTextPreviewGutterTopOffset(
  element: HTMLElement,
  lineBox: { top: number },
  lineNumberBox: { top: number }
): number | undefined {
  const topDelta = lineBox.top - lineNumberBox.top;
  if (Math.abs(topDelta) <= CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_TOP_TOLERANCE_PX) {
    return 0;
  }
  const contentPaddingTop = canvasTextPreviewContentPaddingTop(element);
  if (Math.abs(topDelta - contentPaddingTop) <= CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_TOP_TOLERANCE_PX) {
    return contentPaddingTop;
  }
  return undefined;
}

function canvasTextPreviewBoxIntersectsScroller(
  element: HTMLElement,
  scroller: HTMLElement,
  scrollerRect: DOMRect
): boolean {
  const box = canvasTextPreviewViewportBox(element, scrollerRect);
  const viewportHeight = scroller.clientHeight;
  return Number.isFinite(box.top)
    && Number.isFinite(box.height)
    && Number.isFinite(viewportHeight)
    && box.height > 0
    && viewportHeight > 0
    && box.top + box.height >= 0
    && box.top <= viewportHeight;
}

function canvasTextPreviewViewportBox(
  element: HTMLElement,
  scrollerRect: DOMRect
): { top: number; left: number; width: number; height: number } {
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top - scrollerRect.top,
    left: rect.left - scrollerRect.left,
    width: rect.width,
    height: rect.height
  };
}

function cloneCanvasTextPreviewVisibleElement(
  element: HTMLElement,
  scrollerRect: DOMRect,
  topOffset = 0
): HTMLElement {
  const box = canvasTextPreviewViewportBox(element, scrollerRect);
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.position = 'absolute';
  clone.style.display = 'block';
  clone.style.boxSizing = 'border-box';
  clone.style.top = `${box.top + topOffset}px`;
  clone.style.left = `${box.left}px`;
  clone.style.width = `${box.width}px`;
  clone.style.height = `${box.height}px`;
  clone.style.minHeight = `${box.height}px`;
  clone.style.margin = '0';
  clone.style.transform = 'none';
  return clone;
}

async function canvasTextPreviewFontsReady(): Promise<void> {
  const fontSet = typeof document !== 'undefined' ? document.fonts : undefined;
  if (!fontSet) {
    return;
  }
  await fontSet.ready.catch(() => undefined);
}

function canvasTextPreviewAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

function CanvasTextPreviewCaptureTarget({
  target,
  actions,
  onComplete
}: {
  target: CanvasTextPreviewTarget;
  actions: WorkbenchActions;
  onComplete: (target: CanvasTextPreviewTarget, result: CanvasTextPreviewCaptureResult) => void;
}): React.ReactElement {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const [editorLayoutReady, setEditorLayoutReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const element = elementRef.current;
    if (!element || !editorLayoutReady) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const layoutReady = await waitForCanvasTextPreviewCaptureLayout(element, {
            isCancelled: () => cancelled
          });
          if (cancelled || !layoutReady) {
            return;
          }
          prepareCanvasTextPreviewCaptureElement(element);
          const sourcePng = await captureCanvasTextPreviewSource({ element });
          if (cancelled) {
            return;
          }
          await actions.saveCanvasTextPreviewSource({
            ...canvasTextPreviewSourceTargetForApi(target),
            canvasId: target.canvasId,
            sourcePng
          });
          if (cancelled) {
            return;
          }
          onComplete(target, { status: 'ok' });
        } catch (error) {
          if (!cancelled) {
            onComplete(target, {
              status: 'error',
              message: messageFromUnknown(error)
            });
          }
        }
      })();
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [actions, editorLayoutReady, onComplete, target]);

  return (
    <div
      ref={elementRef}
      className="canvas-text-preview-capture-target canvas-text-body"
      style={{
        width: target.contentCssWidth,
        height: target.contentCssHeight,
        overflow: 'hidden'
      }}
    >
      <CanvasTextEditor
        value={target.content}
        language={target.language}
        wordWrap={target.wordWrap}
        visible
        initialScrollTop={target.scrollTop}
        initialScrollLeft={target.scrollLeft}
        onChange={() => undefined}
        onSave={() => undefined}
        onToggleWordWrap={() => undefined}
        onLayoutReady={() => setEditorLayoutReady(true)}
      />
    </div>
  );
}

function canvasTextPreviewForNode(input: {
  canvasId: string;
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget | undefined;
  resourceZoom: number;
  devicePixelRatio: number;
}): CanvasTextPreviewSource | undefined {
  if (input.node.availability.state !== 'available'
    || !input.node.availability.fileUrl
    || !input.target) {
    return undefined;
  }
  const targetWidth = canvasTextPreviewTargetWidthForNode({
    node: input.node,
    target: input.target,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  const src = canvasTextPreviewUrl({
    fileUrl: input.node.availability.fileUrl,
    canvasId: input.canvasId,
    projectRelativePath: input.node.projectRelativePath,
    fingerprint: input.target.fingerprint,
    width: targetWidth
  }).toString();
  return { src, previewWidth: targetWidth, fingerprint: input.target.fingerprint };
}

export function canvasTextPreviewTargetWidthForNode(input: {
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  resourceZoom: number;
  devicePixelRatio: number;
}): number {
  return canvasRasterPreviewWidth({
    nodeDisplayWidth: input.node.width,
    sourceWidth: input.target.contentCssWidth * CANVAS_TEXT_PREVIEW_SOURCE_SCALE,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
}

function canvasTextPreviewUrl(input: {
  fileUrl: string;
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
  width: number;
}): string {
  const sourceUrl = new URL(input.fileUrl, 'http://debrute.local');
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas text preview file URL must include a project id.');
  }
  const params = new URLSearchParams({
    canvasId: input.canvasId,
    path: input.projectRelativePath,
    fingerprint: input.fingerprint,
    w: String(input.width)
  });
  return `/api/projects/${projectMatch[1]}/canvas-text-preview?${params.toString()}`;
}

function canvasTextPreviewSourceTargetForApi(target: CanvasTextPreviewTarget) {
  return {
    projectRelativePath: target.projectRelativePath,
    fingerprint: target.fingerprint
  };
}

function canvasTextPreviewTargetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

type CanvasTextPreviewCaptureResult =
  | { status: 'ok' }
  | { status: 'error'; message: string };

export function canvasTextPreviewBodyMeasurement(
  element: HTMLElement
): CanvasTextPreviewMeasuredBody {
  return {
    width: element.clientWidth,
    height: element.clientHeight
  };
}

export function canvasTextPreviewNextCaptureTargets(input: {
  targets: CanvasTextPreviewTarget[];
  sourceAvailability: Record<string, CanvasTextPreviewSourceAvailability>;
  pendingCaptureKeys: Set<string>;
  skippedCaptureKeys?: ReadonlySet<string> | undefined;
  concurrency: number;
}): CanvasTextPreviewTarget[] {
  const slots = Math.max(0, input.concurrency - input.pendingCaptureKeys.size);
  if (slots === 0) {
    return [];
  }
  const nextCaptures: CanvasTextPreviewTarget[] = [];
  for (const target of input.targets) {
    if (nextCaptures.length >= slots) {
      break;
    }
    const availability = input.sourceAvailability[target.projectRelativePath];
    if (!availability || availability.fingerprint !== target.fingerprint || availability.available) {
      continue;
    }
    const captureKey = canvasTextPreviewTargetKey(target);
    if (input.pendingCaptureKeys.has(captureKey) || input.skippedCaptureKeys?.has(captureKey)) {
      continue;
    }
    input.pendingCaptureKeys.add(captureKey);
    nextCaptures.push(target);
  }
  return nextCaptures;
}

export function canvasTextPreviewCurrentSourceAvailability(input: {
  targets: CanvasTextPreviewTarget[];
  sourceAvailability: Record<string, CanvasTextPreviewSourceAvailability>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  const targetByPath = canvasTextPreviewTargetsByPath(input.targets);
  const currentAvailability: Record<string, CanvasTextPreviewSourceAvailability> = {};
  for (const [projectRelativePath, availability] of Object.entries(input.sourceAvailability)) {
    const target = targetByPath[projectRelativePath];
    if (target && availability.fingerprint === target.fingerprint) {
      currentAvailability[projectRelativePath] = availability;
    }
  }
  return currentAvailability;
}

function canvasTextPreviewCurrentSources(input: {
  targets: CanvasTextPreviewTarget[];
  sources: Record<string, CanvasTextPreviewPublishedSource>;
}): Record<string, CanvasTextPreviewPublishedSource> {
  const targetKeysByPath = new Map(input.targets.map((target) => [
    target.projectRelativePath,
    canvasTextPreviewTargetKey(target)
  ]));
  const currentSources: Record<string, CanvasTextPreviewPublishedSource> = {};
  for (const [projectRelativePath, source] of Object.entries(input.sources)) {
    if (targetKeysByPath.get(projectRelativePath) === source.targetKey) {
      currentSources[projectRelativePath] = source;
    }
  }
  return currentSources;
}

function canvasTextPreviewSourcesWithAvailability(input: {
  current: Record<string, CanvasTextPreviewSourceAvailability>;
  targets: CanvasTextPreviewTarget[];
  sources: Record<string, { fingerprint: string; available: boolean }>;
}): Record<string, CanvasTextPreviewSourceAvailability> {
  let next = input.current;
  for (const target of input.targets) {
    const source = input.sources[target.projectRelativePath];
    const availability = {
      fingerprint: target.fingerprint,
      available: Boolean(source && source.fingerprint === target.fingerprint && source.available)
    };
    const currentAvailability = next[target.projectRelativePath];
    if (currentAvailability
      && currentAvailability.fingerprint === availability.fingerprint
      && currentAvailability.available === availability.available) {
      continue;
    }
    next = next === input.current ? { ...input.current } : next;
    next[target.projectRelativePath] = availability;
  }
  return next;
}

function canvasTextPreviewSourcesWithTargetSource(input: {
  current: Record<string, CanvasTextPreviewPublishedSource>;
  canvasId: string;
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  targetKey: string;
  resourceZoom: number;
  devicePixelRatio: number;
}): Record<string, CanvasTextPreviewPublishedSource> {
  const source = canvasTextPreviewForNode({
    canvasId: input.canvasId,
    node: input.node,
    target: input.target,
    resourceZoom: input.resourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  if (!source) {
    if (!input.current[input.target.projectRelativePath]) {
      return input.current;
    }
    const next = { ...input.current };
    delete next[input.target.projectRelativePath];
    return next;
  }
  const sourceKey = canvasTextPreviewResourceSourceKey(input.targetKey, source.previewWidth);
  const nextSource = {
    targetKey: input.targetKey,
    sourceKey,
    source
  };
  const currentSource = input.current[input.target.projectRelativePath];
  if (currentSource
    && currentSource.targetKey === nextSource.targetKey
    && currentSource.sourceKey === nextSource.sourceKey
    && currentSource.source.src === nextSource.source.src
    && currentSource.source.previewWidth === nextSource.source.previewWidth) {
    return input.current;
  }
  return {
    ...input.current,
    [input.target.projectRelativePath]: nextSource
  };
}

function canvasTextPreviewResourceSourceKey(targetKey: string, targetWidth: number): string {
  return `${targetKey}\u001f${targetWidth}`;
}

function canvasTextPreviewTargetsByPath(targets: CanvasTextPreviewTarget[]): Record<string, CanvasTextPreviewTarget> {
  return Object.fromEntries(targets.map((target) => [target.projectRelativePath, target]));
}

function clearStaleCanvasTextPreviewErrors(
  errors: Record<string, { captureKey: string; message: string }>,
  targets: CanvasTextPreviewTarget[]
): Record<string, { captureKey: string; message: string }> {
  const currentKeys = new Map(targets.map((target) => [target.projectRelativePath, canvasTextPreviewTargetKey(target)]));
  let changed = false;
  const next = { ...errors };
  for (const [projectRelativePath, error] of Object.entries(errors)) {
    if (currentKeys.get(projectRelativePath) !== error.captureKey) {
      delete next[projectRelativePath];
      changed = true;
    }
  }
  return changed ? next : errors;
}

function clearCanvasTextPreviewErrorForPath(
  errors: Record<string, { captureKey: string; message: string }>,
  projectRelativePath: string
): Record<string, { captureKey: string; message: string }> {
  if (!errors[projectRelativePath]) {
    return errors;
  }
  const next = { ...errors };
  delete next[projectRelativePath];
  return next;
}

function canvasTextPreviewErrorsForTargets(input: {
  current: Record<string, { captureKey: string; message: string }>;
  targets: CanvasTextPreviewTarget[];
  message: string;
}): Record<string, { captureKey: string; message: string }> {
  const next = { ...input.current };
  for (const target of input.targets) {
    next[target.projectRelativePath] = {
      captureKey: canvasTextPreviewTargetKey(target),
      message: input.message
    };
  }
  return next;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorFromUnknown(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
