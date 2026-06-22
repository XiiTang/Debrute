import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canvasFeedbackEntryHasLocalRegions,
  canvasFeedbackRenderedProjectPath,
  normalizeCanvasFeedbackProjectRelativePath,
  type CanvasFeedbackDocument,
  type CanvasFeedbackEntry,
  type Diagnostic
} from '@debrute/canvas-core';
import { resolveProjectPath } from '@debrute/project-core';
import {
  canvasFeedbackRenderDiagnostic,
  removeCanvasFeedbackRenderedArtifact,
  removeUnexpectedCanvasFeedbackRenderedArtifacts
} from './CanvasFeedbackRenderedImageService.js';
import type {
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobResult
} from './CanvasFeedbackRenderedImageWorkerProtocol.js';

const DEFAULT_MAX_CONCURRENT_IMAGES = 2;

export interface CanvasFeedbackRenderDiagnosticUpdate {
  readonly diagnostics: Diagnostic[];
  readonly checkedProjectRelativePaths: string[];
  readonly checkedAllEntries?: boolean;
  readonly retainedProjectRelativePaths?: string[];
}

export interface CanvasFeedbackRenderRunner {
  render(input: CanvasFeedbackRenderJobInput, signal: AbortSignal): Promise<CanvasFeedbackRenderJobResult>;
}

export interface CanvasFeedbackRenderScheduler {
  enqueueDocument(input: {
    readonly projectRoot: string;
    readonly document: CanvasFeedbackDocument;
  }): void;
  enqueueSource(input: {
    readonly projectRoot: string;
    readonly projectRelativePath: string;
    readonly document: CanvasFeedbackDocument;
  }): void;
  cancelProject(projectRoot: string): void;
  dispose(): Promise<void>;
}

export interface CanvasFeedbackRenderSchedulerOptions {
  readonly runner: CanvasFeedbackRenderRunner;
  readonly maxConcurrentImages?: number;
  readonly onDiagnostic: (diagnostic: CanvasFeedbackRenderDiagnosticUpdate) => void;
}

interface RenderKeyState {
  readonly key: string;
  readonly projectRoot: string;
  readonly projectRelativePath: string;
  generation: number;
  queued: RenderGeneration | undefined;
  active: ActiveRenderGeneration | undefined;
  queuedForStart: boolean;
}

interface RenderGeneration {
  readonly generation: number;
  readonly jobId: string;
  readonly entry: CanvasFeedbackEntry;
}

interface ActiveRenderGeneration extends RenderGeneration {
  controller: AbortController;
  tempPath: string;
  promise: Promise<void>;
}

export class CanvasFeedbackRenderCancelledError extends Error {
  constructor() {
    super('Canvas feedback render cancelled.');
    this.name = 'CanvasFeedbackRenderCancelledError';
  }
}

export function createCanvasFeedbackRenderScheduler(
  options: CanvasFeedbackRenderSchedulerOptions
): CanvasFeedbackRenderScheduler {
  return new LocalCanvasFeedbackRenderScheduler(options);
}

class LocalCanvasFeedbackRenderScheduler implements CanvasFeedbackRenderScheduler {
  private readonly runner: CanvasFeedbackRenderRunner;
  private readonly maxConcurrentImages: number;
  private readonly onDiagnostic: (diagnostic: CanvasFeedbackRenderDiagnosticUpdate) => void;
  private readonly states = new Map<string, RenderKeyState>();
  private readonly readyQueue: RenderKeyState[] = [];
  private activeCount = 0;
  private disposed = false;

  constructor(options: CanvasFeedbackRenderSchedulerOptions) {
    this.runner = options.runner;
    this.maxConcurrentImages = options.maxConcurrentImages ?? DEFAULT_MAX_CONCURRENT_IMAGES;
    this.onDiagnostic = options.onDiagnostic;
  }

  enqueueDocument(input: { projectRoot: string; document: CanvasFeedbackDocument }): void {
    if (this.disposed) {
      return;
    }
    const expectedRenderedPaths = new Set<string>();
    const activeProjectRelativePaths = new Set<string>();
    for (const entry of Object.values(input.document.entries)) {
      if (!canvasFeedbackEntryHasLocalRegions(entry)) {
        continue;
      }
      expectedRenderedPaths.add(canvasFeedbackRenderedProjectPath(entry.projectRelativePath));
      activeProjectRelativePaths.add(entry.projectRelativePath);
      this.enqueueSource({
        projectRoot: input.projectRoot,
        projectRelativePath: entry.projectRelativePath,
        document: input.document
      });
    }
    for (const state of this.states.values()) {
      if (state.projectRoot === input.projectRoot && !activeProjectRelativePaths.has(state.projectRelativePath)) {
        this.removeSource(input.projectRoot, state.projectRelativePath);
      }
    }
    void removeUnexpectedCanvasFeedbackRenderedArtifacts(input.projectRoot, expectedRenderedPaths);
    this.onDiagnostic({
      diagnostics: [],
      checkedProjectRelativePaths: [],
      checkedAllEntries: true,
      retainedProjectRelativePaths: [...activeProjectRelativePaths].sort()
    });
  }

  enqueueSource(input: { projectRoot: string; projectRelativePath: string; document: CanvasFeedbackDocument }): void {
    if (this.disposed) {
      return;
    }
    const projectRelativePath = normalizeCanvasFeedbackProjectRelativePath(input.projectRelativePath);
    const entry = input.document.entries[projectRelativePath];
    if (!entry || !canvasFeedbackEntryHasLocalRegions(entry)) {
      this.removeSource(input.projectRoot, projectRelativePath);
      return;
    }
    const state = this.stateFor(input.projectRoot, projectRelativePath);
    state.generation += 1;
    state.queued = {
      generation: state.generation,
      jobId: randomUUID(),
      entry
    };
    state.active?.controller.abort();
    this.queueForStart(state);
    this.startReadyJobs();
  }

  cancelProject(projectRoot: string): void {
    for (const state of this.states.values()) {
      if (state.projectRoot !== projectRoot) {
        continue;
      }
      state.queued = undefined;
      state.queuedForStart = false;
      state.active?.controller.abort();
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const state of this.states.values()) {
      state.queued = undefined;
      state.queuedForStart = false;
      state.active?.controller.abort();
    }
    const activePromises = [...this.states.values()]
      .map((state) => state.active?.promise)
      .filter((promise): promise is Promise<void> => Boolean(promise));
    await Promise.all(activePromises);
  }

  private removeSource(projectRoot: string, projectRelativePath: string): void {
    const state = this.states.get(renderKey(projectRoot, projectRelativePath));
    if (state) {
      state.generation += 1;
      state.queued = undefined;
      state.queuedForStart = false;
      state.active?.controller.abort();
    }
    void removeCanvasFeedbackRenderedArtifact(projectRoot, projectRelativePath).then(() => {
      this.onDiagnostic({
        diagnostics: [],
        checkedProjectRelativePaths: [projectRelativePath]
      });
    });
  }

  private stateFor(projectRoot: string, projectRelativePath: string): RenderKeyState {
    const key = renderKey(projectRoot, projectRelativePath);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const state: RenderKeyState = {
      key,
      projectRoot,
      projectRelativePath,
      generation: 0,
      queued: undefined,
      active: undefined,
      queuedForStart: false
    };
    this.states.set(key, state);
    return state;
  }

  private queueForStart(state: RenderKeyState): void {
    if (state.active || state.queuedForStart || !state.queued) {
      return;
    }
    state.queuedForStart = true;
    this.readyQueue.push(state);
  }

  private startReadyJobs(): void {
    while (!this.disposed && this.activeCount < this.maxConcurrentImages) {
      const state = this.readyQueue.shift();
      if (!state) {
        return;
      }
      state.queuedForStart = false;
      if (state.active || !state.queued) {
        continue;
      }
      this.startJob(state, state.queued);
    }
  }

  private startJob(state: RenderKeyState, generation: RenderGeneration): void {
    state.queued = undefined;
    const controller = new AbortController();
    const finalPath = resolveProjectPath(state.projectRoot, canvasFeedbackRenderedProjectPath(state.projectRelativePath));
    const tempPath = `${finalPath}.${generation.jobId}.tmp`;
    const active: ActiveRenderGeneration = {
      ...generation,
      controller,
      tempPath,
      promise: Promise.resolve()
    };
    active.promise = this.runJob(state, active);
    state.active = active;
    this.activeCount += 1;
  }

  private async runJob(state: RenderKeyState, active: ActiveRenderGeneration): Promise<void> {
    let published = false;
    try {
      const result = await this.runner.render({
        jobId: active.jobId,
        projectRoot: state.projectRoot,
        entry: active.entry,
        outputPath: active.tempPath
      }, active.controller.signal);
      if (!this.isLatestActiveGeneration(state, active)) {
        return;
      }
      if (result.ok) {
        await mkdir(dirname(resolveProjectPath(state.projectRoot, canvasFeedbackRenderedProjectPath(state.projectRelativePath))), { recursive: true });
        await rename(result.outputPath, resolveProjectPath(state.projectRoot, canvasFeedbackRenderedProjectPath(state.projectRelativePath)));
        published = true;
        this.onDiagnostic({
          diagnostics: [],
          checkedProjectRelativePaths: [state.projectRelativePath]
        });
      } else {
        await removeCanvasFeedbackRenderedArtifact(state.projectRoot, state.projectRelativePath);
        this.onDiagnostic({
          diagnostics: [canvasFeedbackRenderDiagnostic(state.projectRoot, state.projectRelativePath, result.message)],
          checkedProjectRelativePaths: [state.projectRelativePath]
        });
      }
    } catch (error) {
      if (!this.isLatestActiveGeneration(state, active) || error instanceof CanvasFeedbackRenderCancelledError) {
        return;
      }
      await removeCanvasFeedbackRenderedArtifact(state.projectRoot, state.projectRelativePath);
      this.onDiagnostic({
        diagnostics: [canvasFeedbackRenderDiagnostic(state.projectRoot, state.projectRelativePath, error)],
        checkedProjectRelativePaths: [state.projectRelativePath]
      });
    } finally {
      if (!published) {
        await rm(active.tempPath, { force: true });
      }
      if (state.active === active) {
        state.active = undefined;
      }
      this.activeCount -= 1;
      if (state.queued) {
        this.queueForStart(state);
      } else if (!state.active) {
        this.states.delete(state.key);
      }
      this.startReadyJobs();
    }
  }

  private isLatestActiveGeneration(state: RenderKeyState, active: ActiveRenderGeneration): boolean {
    return state.active === active && state.generation === active.generation && !active.controller.signal.aborted;
  }
}

function renderKey(projectRoot: string, projectRelativePath: string): string {
  return `${projectRoot}\0${projectRelativePath}`;
}
