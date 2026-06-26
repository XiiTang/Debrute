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
import type { CanvasCameraState } from './runtime/canvasCamera';

const CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY = 3;

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
  | { type: 'next-failed'; loadKey: string };

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

export interface CanvasTextPreviewRuntimeValue {
  descriptors: Record<string, CanvasTextPreviewDescriptor>;
  registerTextBody(projectRelativePath: string, element: HTMLElement | null): void;
  previewForNode(input: {
    node: ProjectedCanvasNode;
    imageResourceZoom: number;
    devicePixelRatio: number;
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
  devicePixelRatio,
  children
}: {
  canvasId: string;
  nodes: ProjectedCanvasNode[];
  selectedProjectRelativePaths: readonly string[];
  textFileBuffers: Record<string, TextFileBuffer>;
  actions: WorkbenchActions;
  cameraState: CanvasCameraState;
  dragState: { kind: string } | undefined;
  devicePixelRatio: number;
  children: React.ReactNode;
}): React.ReactElement {
  const [descriptors, setDescriptors] = useState<Record<string, CanvasTextPreviewDescriptor>>({});
  const [measuredBodies, setMeasuredBodies] = useState<Map<string, CanvasTextPreviewMeasuredBody>>(() => new Map());
  const [captureTargets, setCaptureTargets] = useState<CanvasTextPreviewTarget[]>([]);
  const [captureSlotVersion, setCaptureSlotVersion] = useState(0);
  const [previewErrors, setPreviewErrors] = useState<Record<string, { captureKey: string; message: string }>>({});
  const [currentTargets, setCurrentTargets] = useState<Record<string, CanvasTextPreviewTarget>>({});
  const pendingCaptureKeysRef = useRef(new Set<string>());
  const currentTargetKeysRef = useRef(new Map<string, string>());
  const bodyRegistrationsRef = useRef(new Map<string, () => void>());

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
      measuredBodies
    });
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
      setCurrentTargets(canvasTextPreviewTargetsByPath(targets));
      currentTargetKeysRef.current = new Map(targets.map((target) => [
        target.projectRelativePath,
        canvasTextPreviewTargetKey(target)
      ]));
      setDescriptors((current) => canvasTextPreviewCurrentDescriptors({ targets, descriptors: current }));
      setPreviewErrors((current) => clearStaleCanvasTextPreviewErrors(current, targets));
      const read = await actions.readCanvasTextPreviewDescriptors({
        canvasId,
        nodes: targets.map(canvasTextPreviewTargetForApi)
      });
      if (cancelled) {
        return;
      }
      setDescriptors((current) => canvasTextPreviewCurrentDescriptors({
        targets,
        descriptors: { ...current, ...read.descriptors }
      }));
      setPreviewErrors((current) => clearCanvasTextPreviewErrorsForDescriptors(current, read.descriptors));
      const reconciled = await actions.reconcileCanvasTextPreviews({
        canvasId,
        nodes: targets.map(canvasTextPreviewTargetForApi),
        devicePixelRatio
      });
      if (cancelled) {
        return;
      }
      setDescriptors((current) => canvasTextPreviewCurrentDescriptors({
        targets,
        descriptors: { ...current, ...reconciled.descriptors }
      }));
      setPreviewErrors((current) => clearCanvasTextPreviewErrorsForDescriptors(current, reconciled.descriptors));
      const failedCaptureKeys = new Set(Object.values(previewErrors).map((error) => error.captureKey));
      const nextCaptures = canvasTextPreviewNextCaptureTargets({
        targets,
        descriptors: reconciled.descriptors,
        pendingCaptureKeys: pendingCaptureKeysRef.current,
        skippedCaptureKeys: failedCaptureKeys,
        concurrency: CANVAS_TEXT_PREVIEW_SOURCE_CONCURRENCY
      });
      if (nextCaptures.length > 0) {
        setCaptureTargets((current) => [...current, ...nextCaptures]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    actions,
    cameraState,
    canvasId,
    dragState,
    measuredBodies,
    nodes,
    captureSlotVersion,
    selectedProjectRelativePaths,
    textFileBuffers,
    devicePixelRatio
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
    previewForNode: ({ node, imageResourceZoom: previewZoom, devicePixelRatio: previewDpr }) => canvasTextPreviewForNode({
      canvasId,
      node,
      target: currentTargets[node.projectRelativePath],
      descriptor: descriptors[node.projectRelativePath],
      imageResourceZoom: previewZoom,
      devicePixelRatio: previewDpr
    }),
    previewErrorForNode: ({ node }) => previewErrors[node.projectRelativePath]?.message
  }), [canvasId, currentTargets, descriptors, previewErrors, registerTextBody]);

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
}): CanvasTextPreviewCandidate[] {
  const selected = new Set(input.selectedProjectRelativePaths);
  const targets: CanvasTextPreviewCandidate[] = [];
  for (const node of input.nodes) {
    if (node.nodeKind !== 'file'
      || node.mediaKind !== 'text'
      || node.availability.state !== 'available'
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

  useEffect(() => {
    let cancelled = false;
    const element = elementRef.current;
    if (!element) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const sourcePng = await captureCanvasTextPreviewSource({
            element,
            sourceScale: Math.max(1, devicePixelRatio)
          });
          await actions.saveCanvasTextPreviewSource({
            ...canvasTextPreviewTargetForApi(target),
            canvasId: target.canvasId,
            sourcePng
          });
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
  }, [actions, devicePixelRatio, onComplete, target]);

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
  const targetWidth = canvasRasterPreviewWidth({
    nodeDisplayWidth: input.descriptor.contentCssWidth,
    sourceWidth: input.descriptor.sourceWidth,
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
