import {
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  updateCanvasFeedbackEntry,
  type CanvasFeedbackDocument,
  type UpdateCanvasFeedbackEntryInput
} from '@debrute/canvas-core';
import { readFile } from 'node:fs/promises';
import { resolveExistingProjectPath, resolveProjectPath, resolveProjectPathForWrite } from '@debrute/project-core';
import { commitProjectDocumentTransaction, projectDocumentTextHash } from '../project-documents/ProjectDocumentTransaction.js';

const CANVAS_FEEDBACK_PROJECT_PATH = '.debrute/reviews/canvas-feedback.json';

export interface CanvasFeedbackService {
  readCanvasFeedback(projectRoot: string): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(projectRoot: string, input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument>;
}

export interface CanvasFeedbackServiceOptions {
  now?: () => string;
  writeStructuredDocument?: (projectRoot: string, absolutePath: string, content: string, expectedHash: string | null) => Promise<void>;
}

export function createCanvasFeedbackService(options: CanvasFeedbackServiceOptions = {}): CanvasFeedbackService {
  const now = options.now ?? (() => new Date().toISOString());
  const writeStructuredDocument = options.writeStructuredDocument ?? (async (projectRoot, absolutePath, content, expectedHash) => {
    await commitProjectDocumentTransaction({
      projectRoot,
      owner: 'canvas-feedback',
      reads: [{ absolutePath, expectedHash }],
      writes: [{ absolutePath, content }]
    });
  });
  const updateQueues = new Map<string, Promise<void>>();
  const service: CanvasFeedbackService = {
    async readCanvasFeedback(projectRoot) {
      return (await readCanvasFeedbackState(projectRoot, now)).document;
    },

    async updateCanvasFeedbackEntry(projectRoot, input) {
      const feedbackFile = await resolveProjectPathForWrite(projectRoot, CANVAS_FEEDBACK_PROJECT_PATH);
      const previous = updateQueues.get(feedbackFile) ?? Promise.resolve();
      const run = previous.then(async () => {
        const current = await readCanvasFeedbackState(projectRoot, now);
        const next = updateCanvasFeedbackEntry(current.document, input, now());
        await writeStructuredDocument(projectRoot, feedbackFile, `${JSON.stringify(next, null, 2)}\n`, current.expectedHash);
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
    }
  };
  return service;
}

async function readCanvasFeedbackState(
  projectRoot: string,
  now: () => string
): Promise<{ document: CanvasFeedbackDocument; expectedHash: string | null }> {
  try {
    const content = await readFile(await resolveExistingProjectPath(projectRoot, CANVAS_FEEDBACK_PROJECT_PATH), 'utf8');
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
