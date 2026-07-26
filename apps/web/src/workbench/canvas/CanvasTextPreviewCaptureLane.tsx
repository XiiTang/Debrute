import React, { useCallback, useEffect, useRef } from 'react';
import { CanvasTextEditor } from './CanvasTextEditor';
import {
  captureCanvasTextPreviewSource,
  type CanvasTextPreviewRasterResult,
  type CanvasTextPreviewTarget
} from './CanvasTextPreviewCapture';
import {
  CanvasTextPreviewFailure,
  canvasTextPreviewFailureFromUnknown,
  type CanvasTextPreviewFailureFields
} from './CanvasTextPreviewFailure';
import {
  createCanvasTextPreviewSceneBuild,
  type CanvasTextPreviewBuiltScene,
  type CanvasTextPreviewSceneBuild,
} from './CanvasTextPreviewScene';
import type { CanvasTextRenderProfile } from './CanvasTextRenderProfile.js';
import { useCanvasTextRenderProfile } from './CanvasTextRenderProfileContext.js';

const CANVAS_TEXT_PREVIEW_CAPTURE_SLICE_MS = 16;
const CANVAS_TEXT_PREVIEW_LAYOUT_FRAME_LIMIT = 30;
const CAPTURE_LAYOUT_TOP_TOLERANCE_PX = 0.5;

export type CanvasTextPreviewCaptureStage =
  | 'capture-ready'
  | 'scene-built'
  | 'raster-completed';

export interface CanvasTextPreviewCaptureStageEvent {
  stage: CanvasTextPreviewCaptureStage;
  target: CanvasTextPreviewTarget;
  durationMs: number;
  sceneWidth?: number | undefined;
  sceneHeight?: number | undefined;
}

export interface CanvasTextPreviewCaptureLaneProps {
  target: CanvasTextPreviewTarget | undefined;
  interactionActive: boolean;
  onStage(event: CanvasTextPreviewCaptureStageEvent): void;
  onRasterized(target: CanvasTextPreviewTarget, result: CanvasTextPreviewRasterResult): void;
  onFailure(target: CanvasTextPreviewTarget, failure: CanvasTextPreviewFailure): void;
}

type LanePhase = 'waiting-layout' | 'readiness' | 'scene' | 'raster' | 'rasterizing' | 'complete';

interface LaneJob {
  key: string;
  target: CanvasTextPreviewTarget;
  renderProfile: CanvasTextRenderProfile;
  phase: LanePhase;
  sceneBuild?: CanvasTextPreviewSceneBuild | undefined;
  builtScene?: CanvasTextPreviewBuiltScene | undefined;
  frame?: number | undefined;
  sceneMaxSliceMs: number;
  readinessAttempts: number;
  disposed: boolean;
}

function releaseSceneBuild(job: LaneJob): void {
  const build = job.sceneBuild;
  job.sceneBuild = undefined;
  build?.dispose();
}

export function CanvasTextPreviewCaptureLane({
  target,
  interactionActive,
  onStage,
  onRasterized,
  onFailure
}: CanvasTextPreviewCaptureLaneProps): React.ReactElement | null {
  const renderProfile = useCanvasTextRenderProfile();
  const elementRef = useRef<HTMLDivElement | null>(null);
  const jobRef = useRef<LaneJob | undefined>(undefined);
  const rasterInFlightRef = useRef(false);
  const interactionActiveRef = useRef(interactionActive);
  const onStageRef = useRef(onStage);
  const onRasterizedRef = useRef(onRasterized);
  const onFailureRef = useRef(onFailure);
  const layoutReadyTargetKeysRef = useRef(new Set<string>());
  interactionActiveRef.current = interactionActive;
  onStageRef.current = onStage;
  onRasterizedRef.current = onRasterized;
  onFailureRef.current = onFailure;
  const targetKey = target ? canvasTextPreviewLaneTargetKey(target) : undefined;

  const disposeJob = useCallback((job: LaneJob) => {
    if (job.disposed) {
      return;
    }
    if (job.frame !== undefined) {
      window.cancelAnimationFrame(job.frame);
      job.frame = undefined;
    }
    if (job.phase === 'rasterizing') {
      return;
    }
    job.disposed = true;
    releaseSceneBuild(job);
  }, []);

  const failJob = useCallback((job: LaneJob, error: unknown) => {
    if (job.disposed) {
      return;
    }
    const stage = job.phase === 'raster' ? 'raster_failed' : 'scene_not_ready';
    const failure = error instanceof CanvasTextPreviewFailure
      ? error
      : canvasTextPreviewFailureFromUnknown(stage, failureFieldsForTarget(job.target), error);
    job.phase = 'complete';
    releaseSceneBuild(job);
    onFailureRef.current(job.target, failure);
  }, []);

  const runJobFrameRef = useRef<(timestamp: number) => void>(() => undefined);
  const scheduleJob = useCallback(() => {
    const job = jobRef.current;
    if (!job
      || job.disposed
      || job.frame !== undefined
      || job.phase === 'waiting-layout'
      || job.phase === 'rasterizing'
      || job.phase === 'complete'
      || (job.phase === 'raster' && rasterInFlightRef.current)
      || interactionActiveRef.current) {
      return;
    }
    job.frame = window.requestAnimationFrame((timestamp) => runJobFrameRef.current(timestamp));
  }, []);

  runJobFrameRef.current = (timestamp) => {
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
      failJob(job, 'Canvas text preview capture element is not mounted.');
      return;
    }
    if (job.phase === 'readiness') {
      const startedAt = performance.now();
      if (!isCanvasTextPreviewCaptureLayoutReady(element)) {
        job.readinessAttempts += 1;
        if (job.readinessAttempts >= CANVAS_TEXT_PREVIEW_LAYOUT_FRAME_LIMIT) {
          failJob(job, 'Canvas text preview CodeMirror layout did not become capture-ready.');
          return;
        }
        scheduleJob();
        return;
      }
      job.phase = 'scene';
      onStageRef.current({
        stage: 'capture-ready',
        target: job.target,
        durationMs: performance.now() - startedAt
      });
      scheduleJob();
      return;
    }
    if (job.phase === 'scene') {
      try {
        const sliceStartedAt = performance.now();
        if (!job.sceneBuild) {
          job.sceneBuild = createCanvasTextPreviewSceneBuild({
            captureRoot: element,
            fields: failureFieldsForTarget(job.target)
          });
        }
        const result = job.sceneBuild.runSlice(timestamp + CANVAS_TEXT_PREVIEW_CAPTURE_SLICE_MS);
        job.sceneMaxSliceMs = Math.max(job.sceneMaxSliceMs, performance.now() - sliceStartedAt);
        if (!result.done) {
          scheduleJob();
          return;
        }
        job.builtScene = result.builtScene;
        job.phase = 'raster';
        onStageRef.current({
          stage: 'scene-built',
          target: job.target,
          durationMs: job.sceneMaxSliceMs,
          sceneWidth: result.builtScene.width,
          sceneHeight: result.builtScene.height
        });
        scheduleJob();
      } catch (error) {
        failJob(job, error);
      }
      return;
    }
    if (job.phase === 'raster' && job.builtScene) {
      const builtScene = job.builtScene;
      job.phase = 'rasterizing';
      rasterInFlightRef.current = true;
      void captureCanvasTextPreviewSource({
        builtScene,
        document: element.ownerDocument,
        renderProfile: job.renderProfile,
        fields: failureFieldsForTarget(job.target)
      }).then((result) => {
        if (job.disposed) {
          return;
        }
        onStageRef.current({
          stage: 'raster-completed',
          target: job.target,
          durationMs: result.rasterDurationMs,
          sceneWidth: result.sceneWidth,
          sceneHeight: result.sceneHeight
        });
        onRasterizedRef.current(job.target, result);
      }, (error: unknown) => {
        if (job.disposed) {
          return;
        }
        job.phase = 'raster';
        failJob(job, error);
      }).finally(() => {
        releaseSceneBuild(job);
        job.disposed = true;
        rasterInFlightRef.current = false;
        scheduleJob();
      });
    }
  };

  useEffect(() => {
    const previous = jobRef.current;
    if (previous) {
      disposeJob(previous);
    }
    if (!target || !targetKey) {
      jobRef.current = undefined;
      return undefined;
    }
    const job: LaneJob = {
      key: targetKey,
      target,
      renderProfile,
      phase: layoutReadyTargetKeysRef.current.has(targetKey) ? 'readiness' : 'waiting-layout',
      readinessAttempts: 0,
      sceneMaxSliceMs: 0,
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
  }, [disposeJob, renderProfile, scheduleJob, target, targetKey]);

  useEffect(() => {
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
  }, [interactionActive, scheduleJob]);

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
        <CanvasTextEditor
          key={targetKey}
          value={target.content}
          language={target.language}
          wordWrap={target.wordWrap}
          visible
          readOnly
          initialScrollTop={target.scrollTop}
          initialScrollLeft={target.scrollLeft}
          onChange={() => undefined}
          onSave={() => undefined}
          onToggleWordWrap={() => undefined}
          onLayoutReady={markEditorLayoutReady}
        />
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

function failureFieldsForTarget(target: CanvasTextPreviewTarget): CanvasTextPreviewFailureFields {
  return {
    canvasId: target.canvasId,
    projectRelativePath: target.projectRelativePath,
    fingerprint: target.fingerprint
  };
}

function canvasTextPreviewLaneTargetKey(target: CanvasTextPreviewTarget): string {
  return `${target.canvasId}\u001f${target.projectRelativePath}\u001f${target.fingerprint}`;
}
