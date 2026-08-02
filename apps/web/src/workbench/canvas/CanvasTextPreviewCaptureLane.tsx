import React, { useCallback, useEffect, useRef } from 'react';
import {
  captureCanvasTextPreviewSource,
  type CanvasTextPreviewCaptureResult,
  type CanvasTextPreviewCaptureTarget
} from './CanvasTextPreviewCapture.js';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure.js';
import {
  CANVAS_PERF_INTERACTION_SESSION_TYPES,
  type CanvasPerfCounterName,
  type CanvasPerfMonitor
} from './CanvasPerfMonitor.js';
import { workbenchStartupTimeline } from '../../startup/workbenchStartupTimeline.js';
import type {
  CanvasTextPreparedFont,
  CanvasTextRenderProfile
} from './CanvasTextRenderProfile.js';
import {
  canvasPreviewResourceInteractionActive,
  type CanvasPreviewResourceScheduler
} from './CanvasPreviewResourceScheduler.js';

const CANVAS_TEXT_PREVIEW_LAYOUT_FRAME_LIMIT = 30;
const CAPTURE_LAYOUT_TOP_TOLERANCE_PX = 0.5;
const CanvasTextEditor = React.lazy(async () => {
  workbenchStartupTimeline.markFeatureRequested('text-editor');
  const module = await import('./CanvasTextEditor.js');
  workbenchStartupTimeline.markFeatureReady('text-editor');
  return { default: module.CanvasTextEditor };
});

export interface CanvasTextPreviewCaptureLaneProps {
  target: CanvasTextPreviewCaptureTarget | undefined;
  renderProfile: CanvasTextRenderProfile;
  preparedFont: CanvasTextPreparedFont | undefined;
  interactionSource: Pick<CanvasPreviewResourceScheduler, 'getInteractionState' | 'subscribeInteraction'>;
  perfMonitor?: Pick<CanvasPerfMonitor, 'recordCounter'> | undefined;
  onRasterized(target: CanvasTextPreviewCaptureTarget, result: CanvasTextPreviewCaptureResult): void;
  onFailure(target: CanvasTextPreviewCaptureTarget, failure: CanvasTextPreviewFailure): void;
}

type LanePhase = 'waiting-layout' | 'readiness' | 'capture' | 'capturing' | 'complete';

interface LaneJob {
  key: string;
  target: CanvasTextPreviewCaptureTarget;
  renderProfile: CanvasTextRenderProfile;
  preparedFont: CanvasTextPreparedFont;
  phase: LanePhase;
  frame?: number | undefined;
  readinessAttempts: number;
  abortController: AbortController;
  disposed: boolean;
}

export function CanvasTextPreviewCaptureLane({
  target,
  renderProfile,
  preparedFont,
  interactionSource,
  perfMonitor,
  onRasterized,
  onFailure
}: CanvasTextPreviewCaptureLaneProps): React.ReactElement | null {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const jobRef = useRef<LaneJob | undefined>(undefined);
  const captureInFlightRef = useRef(false);
  const interactionActiveRef = useRef(
    canvasPreviewResourceInteractionActive(interactionSource.getInteractionState())
  );
  const onRasterizedRef = useRef(onRasterized);
  const onFailureRef = useRef(onFailure);
  const perfMonitorRef = useRef(perfMonitor);
  const layoutReadyTargetKeysRef = useRef(new Set<string>());
  onRasterizedRef.current = onRasterized;
  onFailureRef.current = onFailure;
  perfMonitorRef.current = perfMonitor;
  const targetKey = target ? canvasTextPreviewLaneTargetKey(target) : undefined;

  const record = useCallback((
    name: CanvasPerfCounterName,
    targetValue: CanvasTextPreviewCaptureTarget,
    detail?: Record<string, unknown>
  ) => {
    perfMonitorRef.current?.recordCounter({
      sessionTypes: CANVAS_PERF_INTERACTION_SESSION_TYPES,
      timestamp: performance.now(),
      source: 'CanvasTextPreviewRuntime',
      name,
      detail: {
        projectRelativePath: targetValue.projectRelativePath,
        fingerprint: targetValue.fingerprint,
        ...detail
      }
    });
  }, []);

  const disposeJob = useCallback((job: LaneJob) => {
    if (job.disposed) {
      return;
    }
    job.disposed = true;
    job.abortController.abort();
    if (job.frame !== undefined) {
      window.cancelAnimationFrame(job.frame);
      job.frame = undefined;
    }
  }, []);

  const failJob = useCallback((job: LaneJob, stage: 'capture_not_ready' | 'raster_failed', error: unknown) => {
    if (job.disposed) {
      return;
    }
    job.phase = 'complete';
    const failure = error instanceof CanvasTextPreviewFailure
      ? error
      : canvasTextPreviewFailureFromUnknown(stage, failureFieldsForTarget(job.target), error);
    onFailureRef.current(job.target, failure);
  }, []);

  const runJobFrameRef = useRef<(timestamp: number) => void>(() => undefined);
  const scheduleJob = useCallback(() => {
    const job = jobRef.current;
    if (!job
      || job.disposed
      || job.frame !== undefined
      || job.phase === 'waiting-layout'
      || job.phase === 'capturing'
      || job.phase === 'complete'
      || (job.phase === 'capture' && captureInFlightRef.current)
      || interactionActiveRef.current) {
      return;
    }
    job.frame = window.requestAnimationFrame((timestamp) => runJobFrameRef.current(timestamp));
  }, []);

  runJobFrameRef.current = () => {
    const job = jobRef.current;
    if (!job || job.disposed) {
      return;
    }
    job.frame = undefined;
    if (interactionActiveRef.current) {
      return;
    }
    const element = elementRef.current;
    if (!element) {
      failJob(job, 'capture_not_ready', 'Canvas text preview capture element is not mounted.');
      return;
    }
    if (job.phase === 'readiness') {
      const startedAt = performance.now();
      if (!isCanvasTextPreviewCaptureLayoutReady(element)) {
        job.readinessAttempts += 1;
        if (job.readinessAttempts >= CANVAS_TEXT_PREVIEW_LAYOUT_FRAME_LIMIT) {
          failJob(job, 'capture_not_ready', 'Canvas text preview CodeMirror layout did not become capture-ready.');
          return;
        }
        scheduleJob();
        return;
      }
      job.phase = 'capture';
      record('text-preview-capture-ready', job.target, {
        durationMs: performance.now() - startedAt,
        cssWidth: job.target.contentCssWidth,
        cssHeight: job.target.contentCssHeight,
        sourcePixelWidth: job.target.sourcePixelWidth,
        sourcePixelHeight: job.target.sourcePixelHeight
      });
      scheduleJob();
      return;
    }
    if (job.phase !== 'capture') {
      return;
    }
    job.phase = 'capturing';
    captureInFlightRef.current = true;
    void captureCanvasTextPreviewSource({
        captureRoot: element,
        target: job.target,
        fields: failureFieldsForTarget(job.target),
        preparedFont: job.preparedFont,
        signal: job.abortController.signal,
        isInteractionActive: () => interactionActiveRef.current
      }).then((result) => {
      if (job.disposed) {
        return;
      }
      record('text-preview-dom-snapshot-completed', job.target, {
        durationMs: result.snapshotDurationMs,
        snapshotBytes: result.snapshotBytes,
        snapshotElementCount: result.snapshotElementCount,
        maxSynchronousSliceMs: result.maxSynchronousSliceMs
      });
      record('text-preview-raster-completed', job.target, {
        durationMs: result.rasterDurationMs,
        captureDurationMs: result.captureDurationMs,
        sourcePixelWidth: result.sourcePixelWidth,
        sourcePixelHeight: result.sourcePixelHeight
      });
      onRasterizedRef.current(job.target, result);
    }, (error: unknown) => {
      if (job.disposed || isAbortError(error)) {
        return;
      }
      failJob(job, 'raster_failed', error);
    }).finally(() => {
      job.phase = 'complete';
      captureInFlightRef.current = false;
      scheduleJob();
    });
  };

  useEffect(() => {
    const previous = jobRef.current;
    if (previous) {
      disposeJob(previous);
    }
    if (!target || !targetKey || !preparedFont) {
      jobRef.current = undefined;
      return undefined;
    }
    const job: LaneJob = {
      key: targetKey,
      target,
      renderProfile,
      preparedFont,
      phase: layoutReadyTargetKeysRef.current.has(targetKey) ? 'readiness' : 'waiting-layout',
      readinessAttempts: 0,
      abortController: new AbortController(),
      disposed: false
    };
    jobRef.current = job;
    scheduleJob();
    return () => {
      layoutReadyTargetKeysRef.current.delete(job.key);
      if (jobRef.current === job) {
        jobRef.current = undefined;
      }
      disposeJob(job);
    };
  }, [disposeJob, preparedFont, renderProfile, scheduleJob, target, targetKey]);

  useEffect(() => {
    const syncInteraction = (interaction: ReturnType<typeof interactionSource.getInteractionState>): void => {
      const interactionActive = canvasPreviewResourceInteractionActive(interaction);
      interactionActiveRef.current = interactionActive;
      const job = jobRef.current;
      if (!job) {
        return;
      }
      if (interactionActive) {
        if (job.frame !== undefined) {
          window.cancelAnimationFrame(job.frame);
          job.frame = undefined;
        }
        return;
      }
      scheduleJob();
    };
    syncInteraction(interactionSource.getInteractionState());
    return interactionSource.subscribeInteraction(syncInteraction);
  }, [interactionSource, scheduleJob]);

  const markEditorLayoutReady = useCallback(() => {
    if (targetKey) {
      layoutReadyTargetKeysRef.current.add(targetKey);
    }
    const job = jobRef.current;
    if (!job || job.disposed || job.phase !== 'waiting-layout') {
      return;
    }
    job.phase = 'readiness';
    scheduleJob();
  }, [scheduleJob, targetKey]);

  if (!target) {
    return null;
  }
  return (
    <div className="canvas-text-preview-capture-layer" aria-hidden="true">
      <div
        ref={elementRef}
        className="canvas-text-preview-capture-target canvas-text-body"
        style={{
          width: target.contentCssWidth,
          height: target.contentCssHeight,
          overflow: 'hidden'
        }}
      >
        <React.Suspense fallback={null}>
          <CanvasTextEditor
            key={targetKey}
            value={target.content}
            language={target.language}
            wordWrap={target.wordWrap}
            visible
            readOnly
            fontPurpose="preview"
            initialScrollTop={target.scrollTop}
            initialScrollLeft={target.scrollLeft}
            onChange={() => undefined}
            onSave={() => undefined}
            onToggleWordWrap={() => undefined}
            onLayoutReady={markEditorLayoutReady}
          />
        </React.Suspense>
      </div>
    </div>
  );
}

export function isCanvasTextPreviewCaptureLayoutReady(element: HTMLElement): boolean {
  const scroller = element.querySelector<HTMLElement>('.cm-scroller');
  if (!scroller) {
    return false;
  }
  const scrollerRect = scroller.getBoundingClientRect();
  const firstLine = firstVisibleElement(
    element.querySelectorAll<HTMLElement>('.cm-content .cm-line'),
    scrollerRect
  );
  const firstLineNumber = firstVisibleElement(
    element.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement'),
    scrollerRect
  );
  if (!firstLine || !firstLineNumber) {
    return false;
  }
  const lineTop = firstLine.getBoundingClientRect().top;
  const lineNumberTop = firstLineNumber.getBoundingClientRect().top;
  const delta = lineTop - lineNumberTop;
  if (Math.abs(delta) <= CAPTURE_LAYOUT_TOP_TOLERANCE_PX) {
    return true;
  }
  const content = element.querySelector<HTMLElement>('.cm-content');
  const paddingTop = content ? Number.parseFloat(getComputedStyle(content).paddingTop) : 0;
  return Number.isFinite(paddingTop)
    && Math.abs(delta - paddingTop) <= CAPTURE_LAYOUT_TOP_TOLERANCE_PX;
}

function firstVisibleElement(
  elements: NodeListOf<HTMLElement>,
  viewport: DOMRect
): HTMLElement | undefined {
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0
      && rect.height > 0
      && rect.right > viewport.left
      && rect.left < viewport.right
      && rect.bottom > viewport.top
      && rect.top < viewport.bottom) {
      return element;
    }
  }
  return undefined;
}

function failureFieldsForTarget(target: CanvasTextPreviewCaptureTarget): CanvasTextPreviewFailureFields {
  return {
    canvasId: target.canvasId,
    projectRelativePath: target.projectRelativePath,
    fingerprint: target.fingerprint
  };
}

function canvasTextPreviewLaneTargetKey(target: CanvasTextPreviewCaptureTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
