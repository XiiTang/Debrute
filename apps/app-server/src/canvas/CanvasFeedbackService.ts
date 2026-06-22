import {
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  normalizeCanvasFeedbackProjectRelativePath,
  updateCanvasFeedbackEntry,
  type CanvasFeedbackDocument,
  type CanvasMediaKind,
  type UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import { readFile } from 'node:fs/promises';
import { resolveProjectPath, resolveProjectPathForWrite } from '@debrute/project-core';
import { commitProjectDocumentTransaction, projectDocumentTextHash } from '../project-documents/ProjectDocumentTransaction.js';
import { canvasMediaKindFromPath } from './CanvasProjectionService.js';
import type { CanvasFeedbackRenderScheduler } from './CanvasFeedbackRenderedImageScheduler.js';

const CANVAS_FEEDBACK_PROJECT_PATH = '.debrute/reviews/canvas-feedback.json';

export interface CanvasFeedbackService {
  readCanvasFeedback(projectRoot: string): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(projectRoot: string, input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument>;
  queueRenderedFeedbackDocument(projectRoot: string): Promise<void>;
  queueRenderedFeedbackForSource(projectRoot: string, projectRelativePath: string): Promise<void>;
}

export interface CanvasFeedbackServiceOptions {
  now?: () => string;
  readStructuredDocument?: (projectRoot: string, absolutePath: string) => Promise<string>;
  writeStructuredDocument?: (projectRoot: string, absolutePath: string, content: string, expectedHash: string | null) => Promise<void>;
  projectMediaKindForPath?: (projectRoot: string, projectRelativePath: string) => CanvasMediaKind | Promise<CanvasMediaKind>;
  renderScheduler: CanvasFeedbackRenderScheduler;
}

export function createCanvasFeedbackService(options: CanvasFeedbackServiceOptions): CanvasFeedbackService {
  const now = options.now ?? (() => new Date().toISOString());
  const readStructuredDocument = options.readStructuredDocument ?? (async (_projectRoot, absolutePath) => readFile(absolutePath, 'utf8'));
  const writeStructuredDocument = options.writeStructuredDocument ?? (async (projectRoot, absolutePath, content, expectedHash) => {
    await commitProjectDocumentTransaction({
      projectRoot,
      owner: 'canvas-feedback',
      reads: [{ absolutePath, expectedHash }],
      writes: [{ absolutePath, content }]
    });
  });
  const renderScheduler = options.renderScheduler;
  const projectMediaKindForPath = options.projectMediaKindForPath ?? ((_projectRoot, projectRelativePath) => canvasMediaKindFromPath(projectRelativePath));
  const updateQueues = new Map<string, Promise<void>>();
  const service: CanvasFeedbackService = {
    async readCanvasFeedback(projectRoot) {
      return (await readCanvasFeedbackState(projectRoot, now, readStructuredDocument)).document;
    },

    async updateCanvasFeedbackEntry(projectRoot, input) {
      const feedbackFile = await resolveProjectPathForWrite(projectRoot, CANVAS_FEEDBACK_PROJECT_PATH);
      const previous = updateQueues.get(feedbackFile) ?? Promise.resolve();
      const run = previous.then(async () => {
        const current = await readCanvasFeedbackState(projectRoot, now, readStructuredDocument);
        const next = updateCanvasFeedbackEntry(current.document, input, now());
        const projectRelativePath = normalizeCanvasFeedbackProjectRelativePath(input.projectRelativePath);
        await assertCanvasFeedbackDocumentLocalRegionsTargetImages({
          projectRoot,
          document: next,
          projectMediaKindForPath
        });
        await writeStructuredDocument(projectRoot, feedbackFile, `${JSON.stringify(next, null, 2)}\n`, current.expectedHash);
        if (canvasFeedbackMutationAffectsRenderedArtifact(input)) {
          renderScheduler.enqueueSource({
            projectRoot,
            document: next,
            projectRelativePath
          });
        }
        return next;
      });
      const queued = run.catch(() => undefined).then(() => undefined);
      updateQueues.set(feedbackFile, queued);
      void queued.then(() => {
        if (updateQueues.get(feedbackFile) === queued) {
          updateQueues.delete(feedbackFile);
        }
      });
      return run;
    },

    async queueRenderedFeedbackDocument(projectRoot) {
      const current = await readCanvasFeedbackState(projectRoot, now, readStructuredDocument);
      await assertCanvasFeedbackDocumentLocalRegionsTargetImages({
        projectRoot,
        document: current.document,
        projectMediaKindForPath
      });
      renderScheduler.enqueueDocument({
        projectRoot,
        document: current.document
      });
    },

    async queueRenderedFeedbackForSource(projectRoot, projectRelativePath) {
      const current = await readCanvasFeedbackState(projectRoot, now, readStructuredDocument);
      await assertCanvasFeedbackDocumentLocalRegionsTargetImages({
        projectRoot,
        document: current.document,
        projectMediaKindForPath
      });
      renderScheduler.enqueueSource({
        projectRoot,
        document: current.document,
        projectRelativePath: normalizeCanvasFeedbackProjectRelativePath(projectRelativePath)
      });
    }
  };
  return service;
}

function canvasFeedbackMutationAffectsRenderedArtifact(input: UpdateCanvasFeedbackEntryInput): boolean {
  if (input.operation === 'add-region' || input.operation === 'delete-region') {
    return true;
  }
  return input.operation === 'update-region' && input.geometry !== undefined;
}

async function assertCanvasFeedbackDocumentLocalRegionsTargetImages(input: {
  projectRoot: string;
  document: CanvasFeedbackDocument;
  projectMediaKindForPath: (projectRoot: string, projectRelativePath: string) => CanvasMediaKind | Promise<CanvasMediaKind>;
}): Promise<void> {
  for (const projectRelativePath of Object.keys(input.document.entries)) {
    await assertCanvasFeedbackLocalRegionsTargetImage({
      projectRoot: input.projectRoot,
      document: input.document,
      projectRelativePath,
      projectMediaKindForPath: input.projectMediaKindForPath
    });
  }
}

async function assertCanvasFeedbackLocalRegionsTargetImage(input: {
  projectRoot: string;
  document: CanvasFeedbackDocument;
  projectRelativePath: string;
  projectMediaKindForPath: (projectRoot: string, projectRelativePath: string) => CanvasMediaKind | Promise<CanvasMediaKind>;
}): Promise<void> {
  const entry = input.document.entries[input.projectRelativePath];
  if (!entry || entry.regions.length === 0) {
    return;
  }
  const mediaKind = await input.projectMediaKindForPath(input.projectRoot, input.projectRelativePath);
  if (mediaKind !== 'image') {
    throw new Error(`Canvas feedback local regions require an image file: ${input.projectRelativePath}`);
  }
}

async function readCanvasFeedbackState(
  projectRoot: string,
  now: () => string,
  readStructuredDocument: (projectRoot: string, absolutePath: string) => Promise<string>
): Promise<{ document: CanvasFeedbackDocument; expectedHash: string | null }> {
  try {
    const absolutePath = resolveProjectPath(projectRoot, CANVAS_FEEDBACK_PROJECT_PATH);
    const content = await readStructuredDocument(projectRoot, absolutePath);
    return {
      document: normalizeCanvasFeedbackDocument(JSON.parse(content)),
      expectedHash: projectDocumentTextHash(content)
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        document: createEmptyCanvasFeedbackDocument(now()),
        expectedHash: null
      };
    }
    throw error;
  }
}

export function canvasFeedbackPaths(projectRoot: string): { feedbackFile: string } {
  return {
    feedbackFile: resolveProjectPath(projectRoot, CANVAS_FEEDBACK_PROJECT_PATH)
  };
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
