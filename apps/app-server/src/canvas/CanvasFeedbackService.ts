import {
  createEmptyCanvasFeedbackDocument,
  normalizeCanvasFeedbackDocument,
  updateCanvasFeedbackEntry,
  type CanvasFeedbackDocument,
  type UpdateCanvasFeedbackEntryInput
} from '@axis/canvas-core';
import { readJsonFile, resolveProjectPath, writeJsonAtomic } from '@axis/project-core';

const CANVAS_FEEDBACK_PROJECT_PATH = '.axis/reviews/canvas-feedback.json';

export interface CanvasFeedbackService {
  readCanvasFeedback(projectRoot: string): Promise<CanvasFeedbackDocument>;
  updateCanvasFeedbackEntry(projectRoot: string, input: UpdateCanvasFeedbackEntryInput): Promise<CanvasFeedbackDocument>;
}

export interface CanvasFeedbackServiceOptions {
  now?: () => string;
}

export function createCanvasFeedbackService(options: CanvasFeedbackServiceOptions = {}): CanvasFeedbackService {
  const now = options.now ?? (() => new Date().toISOString());
  const updateQueues = new Map<string, Promise<void>>();
  const service: CanvasFeedbackService = {
    async readCanvasFeedback(projectRoot) {
      try {
        return normalizeCanvasFeedbackDocument(await readJsonFile<unknown>(canvasFeedbackPaths(projectRoot).feedbackFile));
      } catch (error) {
        if (isNotFoundError(error)) {
          return createEmptyCanvasFeedbackDocument(now());
        }
        throw error;
      }
    },

    async updateCanvasFeedbackEntry(projectRoot, input) {
      const feedbackFile = canvasFeedbackPaths(projectRoot).feedbackFile;
      const previous = updateQueues.get(feedbackFile) ?? Promise.resolve();
      const run = previous.then(async () => {
        const current = await service.readCanvasFeedback(projectRoot);
        const next = updateCanvasFeedbackEntry(current, input, now());
        await writeJsonAtomic(feedbackFile, next);
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
