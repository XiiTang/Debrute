import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  canvasRasterPreviewWidth,
  type CanvasTextPreviewDescriptor,
  type ProjectedCanvasNode
} from '@debrute/canvas-core';
import type { ProjectTextLanguageId } from '@debrute/project-core';
import type { TextFileBuffer, WorkbenchActions } from '../../types';
import { CanvasTextEditor } from './CanvasTextEditor';
import { captureCanvasTextPreviewSource, canvasTextPreviewFingerprint } from './CanvasTextPreviewCapture';
import type { CanvasPreviewResourceScheduler } from './CanvasPreviewResourceScheduler';
import type { CanvasCameraState } from './runtime/canvasCamera';

const CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY = 1;
const CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_MAX_FRAMES = 12;
const CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_TOP_TOLERANCE_PX = 0.5;
const CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_ERROR = 'Canvas text preview CodeMirror layout did not settle before capture.';

export interface CanvasTextPreviewSource {
  src: string;
  previewWidth: number;
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
  | { type: 'next-loaded'; loadKey: string }
  | { type: 'next-failed'; loadKey: string }
  | { type: 'interaction-started' };

export interface CanvasTextPreviewMeasuredBody {
  width: number;
  height: number;
  scrollTop: number;
  scrollLeft: number;
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
}

export interface CanvasTextPreviewTarget extends CanvasTextPreviewCandidate {
  fingerprint: string;
}

interface CanvasTextPreviewPublishedSource {
  targetKey: string;
  sourceKey: string;
  source: CanvasTextPreviewSource;
}

export interface CanvasTextPreviewRuntimeValue {
  descriptors: Record<string, CanvasTextPreviewDescriptor>;
  registerTextBody(projectRelativePath: string, element: HTMLElement | null): void;
  previewForNode(input: {
    node: ProjectedCanvasNode;
  }): CanvasTextPreviewSource | undefined;
  previewErrorForNode(input: {
    node: ProjectedCanvasNode;
  }): string | undefined;
}

const defaultRuntimeValue: CanvasTextPreviewRuntimeValue = {
  descriptors: {},
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
        return state.loaded ? { loaded: state.loaded, next: undefined } : initialCanvasTextPreviewImageState();
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
  imageResourceZoom,
  devicePixelRatio,
  culledNodePaths,
  previewResourceScheduler,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  selectedProjectRelativePaths: readonly string[];
  textFileBuffers: Record<string, TextFileBuffer>;
  actions: WorkbenchActions;
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  imageResourceZoom: number;
  devicePixelRatio: number;
  culledNodePaths: ReadonlySet<string>;
  previewResourceScheduler: CanvasPreviewResourceScheduler;
  children: React.ReactNode;
}): React.ReactElement {
  const [descriptors, setDescriptors] = useState<Record<string, CanvasTextPreviewDescriptor>>({});
  const [measuredBodies, setMeasuredBodies] = useState<Map<string, CanvasTextPreviewMeasuredBody>>(() => new Map());
  const [captureTargets, setCaptureTargets] = useState<CanvasTextPreviewTarget[]>([]);
  const [captureSlotVersion, setCaptureSlotVersion] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, { captureKey: string; message: string }>>({});
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasTextPreviewTarget>>({});
  const [previewSources, setPreviewSources] = useState<Record<string, CanvasTextPreviewPublishedSource>>({});
  const [resourceCheckedTargetKeys, setResourceCheckedTargetKeys] = useState<ReadonlySet<string>>(() => new Set());
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

  const commitTextBodyMeasurement = useCallback((projectRelativePath: string, element: HTMLElement) => {
    setMeasuredBodies((current) => {
      const next = new Map(current);
      const measurement = canvasTextPreviewBodyMeasurement(element, current.get(projectRelativePath));
      const existing = current.get(projectRelativePath);
      if (existing
        && existing.width === measurement.width
        && existing.height === measurement.height
        && existing.scrollTop === measurement.scrollTop
        && existing.scrollLeft === measurement.scrollLeft) {
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
      setMeasuredBodies((current) => {
        if (!current.has(projectRelativePath)) {
          return current;
        }
        const next = new Map(current);
        next.delete(projectRelativePath);
        return next;
      });
      return;
    }

    const commit = () => commitTextBodyMeasurement(projectRelativePath, element);
    const cleanup: Array<() => void> = [];
    element.addEventListener('scroll', commit, true);
    cleanup.push(() => element.removeEventListener('scroll', commit, true));

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
    const candidates = canvasTextPreviewTargetsForNodes({
      canvasId,
      nodes,
      selectedProjectRelativePaths,
      textFileBuffers,
      measuredBodies,
      culledNodePaths
    });
    if (candidates.length === 0) {
      setCurrentTargets((current) => Object.keys(current).length === 0 ? current : {});
      currentTargetKeysRef.current = new Map();
      currentResourceKeysRef.current = new Map();
      setResourceCheckedTargetKeys((current) => current.size === 0 ? current : new Set());
      setDescriptors((current) => Object.keys(current).length === 0 ? current : {});
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
      setCurrentTargets(canvasTextPreviewTargetsByPath(targets));
      currentTargetKeysRef.current = new Map(targets.map((target) => [
        target.projectRelativePath,
        canvasTextPreviewTargetKey(target)
      ]));
      setResourceCheckedTargetKeys((current) => new Set([...current].filter((key) => targetKeySet.has(key))));
      setDescriptors((current) => canvasTextPreviewCurrentDescriptors({ targets, descriptors: current }));
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
    textFileBuffers
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
      const descriptor = descriptors[target.projectRelativePath];
      const targetWidth = descriptor && canvasTextPreviewDescriptorMatchesTarget(descriptor, target)
        ? canvasTextPreviewTargetWidthForNode({
          node,
          descriptor,
          imageResourceZoom,
          devicePixelRatio
        })
        : target.contentCssWidth;
      const sourceKey = canvasTextPreviewResourceSourceKey(targetKey, targetWidth);
      const published = previewSources[target.projectRelativePath];
      if (published?.targetKey === targetKey && published.sourceKey === sourceKey) {
        continue;
      }
      currentResourceKeysRef.current.set(target.projectRelativePath, sourceKey);
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
          void runCanvasTextPreviewResourceWork({
            actions,
            canvasId,
            node,
            target,
            targetKey,
            imageResourceZoom,
            devicePixelRatio,
            isCurrent,
            setDescriptors,
            setPreviewErrors,
            setPreviewSources,
            markResourceChecked: () => {
              setResourceCheckedTargetKeys((current) => {
                if (current.has(targetKey)) {
                  return current;
                }
                const next = new Set(current);
                next.add(targetKey);
                return next;
              });
            }
          }).catch((error: unknown) => {
            if (!isCurrent()) {
              return;
            }
            setPreviewErrors((current) => ({
              ...current,
              [target.projectRelativePath]: {
                captureKey: targetKey,
                message: messageFromUnknown(error)
              }
            }));
          });
        }
      });
    }
  }, [
    actions,
    cameraState,
    canvasId,
    currentTargets,
    descriptors,
    devicePixelRatio,
    dragState,
    imageResourceZoom,
    nodesByPath,
    previewSources,
    previewResourceScheduler
  ]);

  useEffect(() => () => {
    for (const projectRelativePath of currentTargetKeysRef.current.keys()) {
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
      resourceCheckedTargetKeys.has(canvasTextPreviewTargetKey(target))
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
      descriptors,
      pendingCaptureKeys: pendingCaptureKeysRef.current,
      skippedCaptureKeys: failedCaptureKeys,
      concurrency: CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY
    });
    if (nextCaptures.length > 0) {
      setCaptureTargets((current) => [...current, ...nextCaptures]);
    }
  }, [
    cameraState,
    captureSlotVersion,
    currentTargets,
    descriptors,
    dragState,
    previewErrors,
    resourceCheckedTargetKeys
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
      setDescriptors((current) => ({
        ...current,
        [target.projectRelativePath]: result.descriptor
      }));
      setPreviewErrors((current) => {
        if (!current[target.projectRelativePath]) {
          return current;
        }
        const next = { ...current };
        delete next[target.projectRelativePath];
        return next;
      });
      return;
    }
    setPreviewErrors((current) => ({
      ...current,
      [target.projectRelativePath]: {
        captureKey: key,
        message: result.message
      }
    }));
  }, []);

  const value = useMemo<CanvasTextPreviewRuntimeValue>(() => ({
    descriptors,
    registerTextBody,
    previewForNode: ({ node }) => {
      const target = currentTargets[node.projectRelativePath];
      const published = previewSources[node.projectRelativePath];
      return target && published?.targetKey === canvasTextPreviewTargetKey(target)
        ? published.source
        : undefined;
    },
    previewErrorForNode: ({ node }) => previewErrors[node.projectRelativePath]?.message
  }), [currentTargets, descriptors, previewErrors, previewSources, registerTextBody]);

  return (
    <CanvasTextPreviewRuntimeContext.Provider value={value}>
      {children}
      <div className="canvas-text-preview-capture-layer" aria-hidden="true">
        {captureTargets.map((target) => (
          <CanvasTextPreviewCaptureTarget
            key={canvasTextPreviewTargetKey(target)}
            target={target}
            actions={actions}
            devicePixelRatio={devicePixelRatio}
            onComplete={finishCaptureTarget}
          />
        ))}
      </div>
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
}): CanvasTextPreviewCandidate[] {
  const selected = new Set(input.selectedProjectRelativePaths);
  const targets: CanvasTextPreviewCandidate[] = [];
  for (const node of input.nodes) {
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
      scrollTop: measured.scrollTop,
      scrollLeft: measured.scrollLeft
    });
  }
  return targets;
}

export function selectCanvasTextPreviewVariant(input: {
  variants: number[];
  targetWidth: number;
}): number | undefined {
  const variants = [...input.variants].sort((left, right) => left - right);
  return variants.find((width) => width >= input.targetWidth) ?? variants.at(-1);
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

async function runCanvasTextPreviewResourceWork(input: {
  actions: WorkbenchActions;
  canvasId: string;
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  targetKey: string;
  imageResourceZoom: number;
  devicePixelRatio: number;
  isCurrent: () => boolean;
  setDescriptors: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewDescriptor>>>;
  setPreviewErrors: React.Dispatch<React.SetStateAction<Record<string, { captureKey: string; message: string }>>>;
  setPreviewSources: React.Dispatch<React.SetStateAction<Record<string, CanvasTextPreviewPublishedSource>>>;
  markResourceChecked: () => void;
}): Promise<void> {
  const read = await input.actions.readCanvasTextPreviewDescriptors({
    canvasId: input.canvasId,
    nodes: [canvasTextPreviewTargetForApi(input.target)]
  });
  if (!input.isCurrent()) {
    return;
  }
  input.setDescriptors((current) => canvasTextPreviewDescriptorsWithTargetDescriptor({
    current,
    target: input.target,
    descriptors: read.descriptors
  }));
  input.setPreviewErrors((current) => clearCanvasTextPreviewErrorsForDescriptors(current, read.descriptors));

  const reconciled = await input.actions.reconcileCanvasTextPreviews({
    canvasId: input.canvasId,
    nodes: [canvasTextPreviewTargetForApi(input.target)],
    devicePixelRatio: input.devicePixelRatio
  });
  if (!input.isCurrent()) {
    return;
  }
  input.setDescriptors((current) => canvasTextPreviewDescriptorsWithTargetDescriptor({
    current,
    target: input.target,
    descriptors: reconciled.descriptors
  }));
  input.setPreviewErrors((current) => clearCanvasTextPreviewErrorsForDescriptors(current, reconciled.descriptors));
  input.markResourceChecked();
  const descriptor = reconciled.descriptors[input.target.projectRelativePath] ?? read.descriptors[input.target.projectRelativePath];
  input.setPreviewSources((current) => canvasTextPreviewSourcesWithTargetSource({
    current,
    node: input.node,
    canvasId: input.canvasId,
    target: input.target,
    targetKey: input.targetKey,
    descriptor,
    imageResourceZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio
  }));
}

export function isCanvasTextPreviewCaptureLayoutReady(element: HTMLElement): boolean {
  const firstLine = firstMeasuredCanvasTextPreviewElement(element.querySelectorAll('.cm-content .cm-line'));
  const firstLineNumber = firstMeasuredCanvasTextPreviewElement(
    element.querySelectorAll('.cm-lineNumbers .cm-gutterElement')
  );
  if (!firstLine || !firstLineNumber) {
    return false;
  }
  const lineRect = firstLine.getBoundingClientRect();
  const lineNumberRect = firstLineNumber.getBoundingClientRect();
  return Math.abs(lineRect.top - lineNumberRect.top) <= CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_TOP_TOLERANCE_PX;
}

export function prepareCanvasTextPreviewCaptureElement(element: HTMLElement): void {
  const firstLine = firstMeasuredCanvasTextPreviewElement(element.querySelectorAll('.cm-content .cm-line'));
  if (!firstLine) {
    return;
  }
  const content = element.querySelector('.cm-content');
  const contentPaddingTop = content instanceof HTMLElement
    ? window.getComputedStyle(content).paddingTop
    : '0px';
  const lineStyle = window.getComputedStyle(firstLine);
  for (const gutter of element.querySelectorAll('.cm-gutter')) {
    if (gutter instanceof HTMLElement) {
      gutter.style.setProperty('display', 'flex', 'important');
      gutter.style.flexDirection = 'column';
      gutter.style.boxSizing = 'border-box';
      inlineCanvasTextPreviewCaptureProperties(gutter, window.getComputedStyle(gutter), [
        'font-family',
        'font-size',
        'font-variant-numeric',
        'line-height',
        'overflow'
      ]);
      moveFirstCanvasTextPreviewGutterOffsetToPadding(gutter);
    }
  }
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
    translateCanvasTextPreviewCaptureElement(gutterElement, contentPaddingTop);
  }
}

export async function waitForCanvasTextPreviewCaptureLayout(
  element: HTMLElement,
  options: {
    maxFrames?: number | undefined;
    isCancelled?: (() => boolean) | undefined;
  } = {}
): Promise<boolean> {
  await canvasTextPreviewFontsReady();
  const maxFrames = options.maxFrames ?? CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_MAX_FRAMES;
  for (let frame = 0; frame <= maxFrames; frame += 1) {
    if (options.isCancelled?.()) {
      return false;
    }
    if (isCanvasTextPreviewCaptureLayoutReady(element)) {
      return true;
    }
    if (frame < maxFrames) {
      await canvasTextPreviewAnimationFrame();
    }
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

function moveFirstCanvasTextPreviewGutterOffsetToPadding(gutter: HTMLElement): void {
  const firstVisibleGutterElement = firstMeasuredCanvasTextPreviewElement(gutter.querySelectorAll('.cm-gutterElement'));
  if (!firstVisibleGutterElement) {
    return;
  }
  const marginTop = parseFloat(window.getComputedStyle(firstVisibleGutterElement).marginTop);
  if (!Number.isFinite(marginTop) || marginTop <= 0) {
    return;
  }
  const gutterStyle = window.getComputedStyle(gutter);
  const paddingTop = parseFloat(gutterStyle.paddingTop);
  gutter.style.paddingTop = `${(Number.isFinite(paddingTop) ? paddingTop : 0) + marginTop}px`;
  firstVisibleGutterElement.style.marginTop = '0px';
}

function translateCanvasTextPreviewCaptureElement(element: HTMLElement, translateY: string): void {
  const offset = parseFloat(translateY);
  if (!Number.isFinite(offset) || offset === 0) {
    return;
  }
  element.style.transform = `translateY(${translateY})`;
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
  devicePixelRatio,
  onComplete
}: {
  target: CanvasTextPreviewTarget;
  actions: WorkbenchActions;
  devicePixelRatio: number;
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
          prepareCanvasTextPreviewCaptureElement(element);
          const layoutReady = await waitForCanvasTextPreviewCaptureLayout(element, {
            isCancelled: () => cancelled
          });
          if (cancelled) {
            return;
          }
          if (!layoutReady) {
            onComplete(target, {
              status: 'error',
              message: CANVAS_TEXT_PREVIEW_CAPTURE_LAYOUT_ERROR
            });
            return;
          }
          const sourcePng = await captureCanvasTextPreviewSource({ element });
          if (cancelled) {
            return;
          }
          await actions.saveCanvasTextPreviewSource({
            ...canvasTextPreviewTargetForApi(target),
            canvasId: target.canvasId,
            sourcePng
          });
          if (cancelled) {
            return;
          }
          const reconciled = await actions.reconcileCanvasTextPreviews({
            canvasId: target.canvasId,
            nodes: [canvasTextPreviewTargetForApi(target)],
            devicePixelRatio
          });
          if (!cancelled) {
            const descriptor = reconciled.descriptors[target.projectRelativePath];
            if (!descriptor) {
              onComplete(target, {
                status: 'error',
                message: `Canvas text preview descriptor was not generated for ${target.projectRelativePath}.`
              });
              return;
            }
            onComplete(target, { status: 'ok', descriptor });
          }
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
  }, [actions, devicePixelRatio, editorLayoutReady, onComplete, target]);

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
  descriptor: CanvasTextPreviewDescriptor | undefined;
  imageResourceZoom: number;
  devicePixelRatio: number;
}): CanvasTextPreviewSource | undefined {
  if (input.node.availability.state !== 'available'
    || !input.node.availability.fileUrl
    || !input.target
    || !input.descriptor
    || !canvasTextPreviewDescriptorMatchesTarget(input.descriptor, input.target)) {
    return undefined;
  }
  const targetWidth = canvasTextPreviewTargetWidthForNode({
    node: input.node,
    descriptor: input.descriptor,
    imageResourceZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
  const previewWidth = selectCanvasTextPreviewVariant({
    variants: input.descriptor.variants,
    targetWidth
  });
  if (!previewWidth) {
    return undefined;
  }
  const src = canvasTextPreviewUrl({
    fileUrl: input.node.availability.fileUrl,
    canvasId: input.canvasId,
    projectRelativePath: input.node.projectRelativePath,
    fingerprint: input.descriptor.fingerprint,
    width: previewWidth
  }).toString();
  return { src, previewWidth };
}

function canvasTextPreviewTargetWidthForNode(input: {
  node: ProjectedCanvasNode;
  descriptor: CanvasTextPreviewDescriptor;
  imageResourceZoom: number;
  devicePixelRatio: number;
}): number {
  return canvasRasterPreviewWidth({
    nodeDisplayWidth: input.node.width,
    sourceWidth: input.descriptor.sourceWidth,
    imageResourceZoom: input.imageResourceZoom,
    devicePixelRatio: input.devicePixelRatio
  });
}

function canvasTextPreviewUrl(input: {
  fileUrl: string;
  canvasId: string;
  projectRelativePath: string;
  fingerprint: string;
  width: number;
}): URL {
  const sourceUrl = new URL(input.fileUrl);
  const projectMatch = sourceUrl.pathname.match(/^\/api\/projects\/([^/]+)\//);
  if (!projectMatch?.[1]) {
    throw new Error('Canvas text preview file URL must include a project id.');
  }
  const url = new URL(`/api/projects/${projectMatch[1]}/canvas-text-preview`, sourceUrl);
  url.searchParams.set('canvasId', input.canvasId);
  url.searchParams.set('path', input.projectRelativePath);
  url.searchParams.set('fingerprint', input.fingerprint);
  url.searchParams.set('w', String(input.width));
  const daemonToken = sourceUrl.searchParams.get('debrute-token');
  if (daemonToken) {
    url.searchParams.set('debrute-token', daemonToken);
  }
  return url;
}

function canvasTextPreviewTargetForApi(target: CanvasTextPreviewTarget) {
  return {
    projectRelativePath: target.projectRelativePath,
    fingerprint: target.fingerprint,
    contentCssWidth: target.contentCssWidth,
    contentCssHeight: target.contentCssHeight,
    scrollTop: target.scrollTop,
    scrollLeft: target.scrollLeft
  };
}

function canvasTextPreviewTargetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

export type CanvasTextPreviewScheduledCapture = CanvasTextPreviewTarget & { captureKey: string };

type CanvasTextPreviewCaptureResult =
  | { status: 'ok'; descriptor: CanvasTextPreviewDescriptor }
  | { status: 'error'; message: string };

export function canvasTextPreviewBodyMeasurement(
  element: HTMLElement,
  previous?: CanvasTextPreviewMeasuredBody | undefined
): CanvasTextPreviewMeasuredBody {
  const scroller = element.querySelector('.cm-scroller') as HTMLElement | null;
  return {
    width: element.clientWidth,
    height: element.clientHeight,
    scrollTop: scroller ? scroller.scrollTop : previous?.scrollTop ?? element.scrollTop,
    scrollLeft: scroller ? scroller.scrollLeft : previous?.scrollLeft ?? element.scrollLeft
  };
}

export function canvasTextPreviewNextCaptureTargets(input: {
  targets: CanvasTextPreviewTarget[];
  descriptors: Record<string, CanvasTextPreviewDescriptor>;
  pendingCaptureKeys: Set<string>;
  skippedCaptureKeys?: ReadonlySet<string> | undefined;
  concurrency: number;
}): CanvasTextPreviewScheduledCapture[] {
  const slots = Math.max(0, input.concurrency - input.pendingCaptureKeys.size);
  if (slots === 0) {
    return [];
  }
  const nextCaptures: CanvasTextPreviewScheduledCapture[] = [];
  for (const target of input.targets) {
    if (nextCaptures.length >= slots) {
      break;
    }
    if (input.descriptors[target.projectRelativePath]) {
      continue;
    }
    const captureKey = canvasTextPreviewTargetKey(target);
    if (input.pendingCaptureKeys.has(captureKey) || input.skippedCaptureKeys?.has(captureKey)) {
      continue;
    }
    input.pendingCaptureKeys.add(captureKey);
    nextCaptures.push({ ...target, captureKey });
  }
  return nextCaptures;
}

export function canvasTextPreviewCurrentDescriptors(input: {
  targets: CanvasTextPreviewTarget[];
  descriptors: Record<string, CanvasTextPreviewDescriptor>;
}): Record<string, CanvasTextPreviewDescriptor> {
  const targetByPath = canvasTextPreviewTargetsByPath(input.targets);
  const currentDescriptors: Record<string, CanvasTextPreviewDescriptor> = {};
  for (const [projectRelativePath, descriptor] of Object.entries(input.descriptors)) {
    const target = targetByPath[projectRelativePath];
    if (target && canvasTextPreviewDescriptorMatchesTarget(descriptor, target)) {
      currentDescriptors[projectRelativePath] = descriptor;
    }
  }
  return currentDescriptors;
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

function canvasTextPreviewDescriptorsWithTargetDescriptor(input: {
  current: Record<string, CanvasTextPreviewDescriptor>;
  target: CanvasTextPreviewTarget;
  descriptors: Record<string, CanvasTextPreviewDescriptor>;
}): Record<string, CanvasTextPreviewDescriptor> {
  const descriptor = input.descriptors[input.target.projectRelativePath];
  if (descriptor && canvasTextPreviewDescriptorMatchesTarget(descriptor, input.target)) {
    if (canvasTextPreviewDescriptorsEqual(input.current[input.target.projectRelativePath], descriptor)) {
      return input.current;
    }
    const next = { ...input.current };
    next[input.target.projectRelativePath] = descriptor;
    return next;
  }
  if (!input.current[input.target.projectRelativePath]) {
    return input.current;
  }
  const next = { ...input.current };
  delete next[input.target.projectRelativePath];
  return next;
}

function canvasTextPreviewSourcesWithTargetSource(input: {
  current: Record<string, CanvasTextPreviewPublishedSource>;
  canvasId: string;
  node: ProjectedCanvasNode;
  target: CanvasTextPreviewTarget;
  targetKey: string;
  descriptor: CanvasTextPreviewDescriptor | undefined;
  imageResourceZoom: number;
  devicePixelRatio: number;
}): Record<string, CanvasTextPreviewPublishedSource> {
  const source = input.descriptor
    ? canvasTextPreviewForNode({
      canvasId: input.canvasId,
      node: input.node,
      target: input.target,
      descriptor: input.descriptor,
      imageResourceZoom: input.imageResourceZoom,
      devicePixelRatio: input.devicePixelRatio
    })
    : undefined;
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

function canvasTextPreviewDescriptorMatchesTarget(
  descriptor: CanvasTextPreviewDescriptor,
  target: CanvasTextPreviewTarget
): boolean {
  return descriptor.fingerprint === target.fingerprint
    && descriptor.contentCssWidth === target.contentCssWidth
    && descriptor.contentCssHeight === target.contentCssHeight
    && descriptor.scrollTop === target.scrollTop
    && descriptor.scrollLeft === target.scrollLeft;
}

function canvasTextPreviewDescriptorsEqual(
  left: CanvasTextPreviewDescriptor | undefined,
  right: CanvasTextPreviewDescriptor
): boolean {
  if (!left) {
    return false;
  }
  return left.fingerprint === right.fingerprint
    && left.sourceWidth === right.sourceWidth
    && left.sourceHeight === right.sourceHeight
    && left.contentCssWidth === right.contentCssWidth
    && left.contentCssHeight === right.contentCssHeight
    && left.scrollTop === right.scrollTop
    && left.scrollLeft === right.scrollLeft
    && left.variants.length === right.variants.length
    && left.variants.every((width, index) => width === right.variants[index]);
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

function clearCanvasTextPreviewErrorsForDescriptors(
  errors: Record<string, { captureKey: string; message: string }>,
  descriptors: Record<string, CanvasTextPreviewDescriptor>
): Record<string, { captureKey: string; message: string }> {
  let changed = false;
  const next = { ...errors };
  for (const projectRelativePath of Object.keys(descriptors)) {
    if (next[projectRelativePath]) {
      delete next[projectRelativePath];
      changed = true;
    }
  }
  return changed ? next : errors;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
