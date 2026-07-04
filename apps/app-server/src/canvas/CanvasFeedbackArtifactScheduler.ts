import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  canvasFeedbackEntryHasFileSpatialItems,
  canvasFeedbackItemsForMoment,
  canvasFeedbackMomentRefs,
  canvasFeedbackRenderedMomentProjectPath,
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
} from './CanvasFeedbackArtifactService.js';
import type {
  CanvasFeedbackArtifact,
  CanvasFeedbackRenderJobInput,
  CanvasFeedbackRenderJobResult
} from './CanvasFeedbackArtifactWorkerProtocol.js';

const DEFAULT_MAX_CONCURRENT_ARTIFACTS = 2;

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
  readonly maxConcurrentArtifacts?: number;
  readonly onDiagnostic: (diagnostic: CanvasFeedbackRenderDiagnosticUpdate) => void;
}

interface CanvasFeedbackArtifactDescriptor {
  readonly artifactProjectPath: string;
  readonly diagnosticProjectRelativePath: string;
  readonly artifact: CanvasFeedbackArtifact;
}

interface RenderKeyState extends CanvasFeedbackArtifactDescriptor {
  readonly key: string;
  readonly projectRoot: string;
  generation: number;
  queued: RenderGeneration | undefined;
  active: ActiveRenderGeneration | undefined;
  queuedForStart: boolean;
}

interface RenderGeneration {
  readonly generation: number;
  readonly jobId: string;
  readonly artifact: CanvasFeedbackArtifact;
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
  private readonly maxConcurrentArtifacts: number;
  private readonly onDiagnostic: (diagnostic: CanvasFeedbackRenderDiagnosticUpdate) => void;
  private readonly states = new Map<string, RenderKeyState>();
  private readonly readyQueue: RenderKeyState[] = [];
  private activeCount = 0;
  private disposed = false;

  constructor(options: CanvasFeedbackRenderSchedulerOptions) {
    this.runner = options.runner;
    this.maxConcurrentArtifacts = options.maxConcurrentArtifacts ?? DEFAULT_MAX_CONCURRENT_ARTIFACTS;
    this.onDiagnostic = options.onDiagnostic;
  }

  enqueueDocument(input: { projectRoot: string; document: CanvasFeedbackDocument }): void {
    if (this.disposed) {
      return;
    }
    const descriptors = canvasFeedbackArtifactDescriptorsForDocument(input.document);
    const expectedArtifactPaths = new Set(descriptors.map((descriptor) => descriptor.artifactProjectPath));
    const retainedProjectRelativePaths = new Set(descriptors.map((descriptor) => descriptor.diagnosticProjectRelativePath));
    for (const descriptor of descriptors) {
      this.enqueueArtifact(input.projectRoot, descriptor);
    }
    for (const state of this.states.values()) {
      if (state.projectRoot === input.projectRoot && !expectedArtifactPaths.has(state.artifactProjectPath)) {
        this.removeArtifact(state);
      }
    }
    void removeUnexpectedCanvasFeedbackRenderedArtifacts(input.projectRoot, expectedArtifactPaths);
    this.onDiagnostic({
      diagnostics: [],
      checkedProjectRelativePaths: [],
      checkedAllEntries: true,
      retainedProjectRelativePaths: [...retainedProjectRelativePaths].sort()
    });
  }

  enqueueSource(input: { projectRoot: string; projectRelativePath: string; document: CanvasFeedbackDocument }): void {
    if (this.disposed) {
      return;
    }
    const projectRelativePath = normalizeCanvasFeedbackProjectRelativePath(input.projectRelativePath);
    const descriptors = canvasFeedbackArtifactDescriptorsForEntry(input.document.entries[projectRelativePath]);
    const expectedDocumentArtifactPaths = new Set(canvasFeedbackArtifactDescriptorsForDocument(input.document).map((descriptor) => descriptor.artifactProjectPath));
    const expectedSourceArtifactPaths = new Set(descriptors.map((descriptor) => descriptor.artifactProjectPath));
    for (const state of this.states.values()) {
      if (state.projectRoot === input.projectRoot
        && state.artifact.projectRelativePath === projectRelativePath
        && !expectedSourceArtifactPaths.has(state.artifactProjectPath)) {
        this.removeArtifact(state);
      }
    }
    void removeUnexpectedCanvasFeedbackRenderedArtifacts(input.projectRoot, expectedDocumentArtifactPaths);
    if (descriptors.length === 0) {
      this.onDiagnostic({
        diagnostics: [],
        checkedProjectRelativePaths: [projectRelativePath]
      });
      return;
    }
    for (const descriptor of descriptors) {
      this.enqueueArtifact(input.projectRoot, descriptor);
    }
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

  private enqueueArtifact(projectRoot: string, descriptor: CanvasFeedbackArtifactDescriptor): void {
    const state = this.stateFor(projectRoot, descriptor);
    state.generation += 1;
    state.queued = {
      generation: state.generation,
      jobId: randomUUID(),
      artifact: descriptor.artifact
    };
    state.active?.controller.abort();
    this.queueForStart(state);
    this.startReadyJobs();
  }

  private removeArtifact(state: RenderKeyState): void {
    state.generation += 1;
    state.queued = undefined;
    state.queuedForStart = false;
    state.active?.controller.abort();
    void removeCanvasFeedbackRenderedArtifact(state.projectRoot, state.artifactProjectPath).then(() => {
      this.onDiagnostic({
        diagnostics: [],
        checkedProjectRelativePaths: [state.diagnosticProjectRelativePath]
      });
    });
  }

  private stateFor(projectRoot: string, descriptor: CanvasFeedbackArtifactDescriptor): RenderKeyState {
    const key = renderKey(projectRoot, descriptor.artifactProjectPath);
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const state: RenderKeyState = {
      key,
      projectRoot,
      artifactProjectPath: descriptor.artifactProjectPath,
      diagnosticProjectRelativePath: descriptor.diagnosticProjectRelativePath,
      artifact: descriptor.artifact,
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
    while (!this.disposed && this.activeCount < this.maxConcurrentArtifacts) {
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
    const finalPath = resolveProjectPath(state.projectRoot, state.artifactProjectPath);
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
        artifact: active.artifact,
        outputPath: active.tempPath
      }, active.controller.signal);
      if (!this.isLatestActiveGeneration(state, active)) {
        return;
      }
      if (result.ok) {
        await mkdir(dirname(resolveProjectPath(state.projectRoot, state.artifactProjectPath)), { recursive: true });
        await rename(result.outputPath, resolveProjectPath(state.projectRoot, state.artifactProjectPath));
        published = true;
        this.onDiagnostic({
          diagnostics: [],
          checkedProjectRelativePaths: [state.diagnosticProjectRelativePath]
        });
      } else {
        await removeCanvasFeedbackRenderedArtifact(state.projectRoot, state.artifactProjectPath);
        this.onDiagnostic({
          diagnostics: [canvasFeedbackRenderDiagnostic(
            state.projectRoot,
            state.artifact,
            state.artifactProjectPath,
            state.diagnosticProjectRelativePath,
            result.message
          )],
          checkedProjectRelativePaths: [state.diagnosticProjectRelativePath]
        });
      }
    } catch (error) {
      if (!this.isLatestActiveGeneration(state, active) || error instanceof CanvasFeedbackRenderCancelledError) {
        return;
      }
      await removeCanvasFeedbackRenderedArtifact(state.projectRoot, state.artifactProjectPath);
      this.onDiagnostic({
        diagnostics: [canvasFeedbackRenderDiagnostic(
          state.projectRoot,
          state.artifact,
          state.artifactProjectPath,
          state.diagnosticProjectRelativePath,
          error
        )],
        checkedProjectRelativePaths: [state.diagnosticProjectRelativePath]
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

function canvasFeedbackArtifactDescriptorsForDocument(document: CanvasFeedbackDocument): CanvasFeedbackArtifactDescriptor[] {
  return Object.values(document.entries).flatMap(canvasFeedbackArtifactDescriptorsForEntry);
}

function canvasFeedbackArtifactDescriptorsForEntry(entry: CanvasFeedbackEntry | undefined): CanvasFeedbackArtifactDescriptor[] {
  if (!entry) {
    return [];
  }
  const descriptors: CanvasFeedbackArtifactDescriptor[] = [];
  if (canvasFeedbackEntryHasFileSpatialItems(entry)) {
    descriptors.push({
      artifactProjectPath: canvasFeedbackRenderedProjectPath(entry.projectRelativePath),
      diagnosticProjectRelativePath: entry.projectRelativePath,
      artifact: {
        kind: 'image',
        projectRelativePath: entry.projectRelativePath,
        entry
      }
    });
  }
  for (const moment of canvasFeedbackMomentRefs(entry)) {
    if (canvasFeedbackItemsForMoment(entry, moment).length === 0) {
      continue;
    }
    descriptors.push({
      artifactProjectPath: canvasFeedbackRenderedMomentProjectPath(entry.projectRelativePath, moment.label),
      diagnosticProjectRelativePath: `${entry.projectRelativePath}#${moment.label}`,
      artifact: {
        kind: 'video-moment',
        projectRelativePath: entry.projectRelativePath,
        moment,
        entry
      }
    });
  }
  return descriptors;
}

function renderKey(projectRoot: string, artifactProjectPath: string): string {
  return `${projectRoot}\0${artifactProjectPath}`;
}
