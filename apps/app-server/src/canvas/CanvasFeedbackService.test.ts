import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createCanvasFeedbackService
} from './CanvasFeedbackService';
import type { CanvasFeedbackRenderScheduler } from './CanvasFeedbackRenderedImageScheduler';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasFeedbackService materialization', () => {
  it('writes accepted feedback before queueing rendered artifacts for the touched entry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-service-'));
    try {
      const events: string[] = [];
      const enqueueSource = vi.fn((input: Parameters<CanvasFeedbackRenderScheduler['enqueueSource']>[0]) => {
        events.push(`enqueue:${input.projectRelativePath}`);
      });
      const renderScheduler = createScheduler({
        enqueueSource
      });
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
          const document = JSON.parse(content) as { entries?: unknown };
          events.push(`write:${document.entries && typeof document.entries === 'object' ? 'entries' : 'invalid'}`);
        }
      });

      const result = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-region',
        projectRelativePath: 'assets/page.png',
        region: {
          kind: 'pin',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      });

      expect(enqueueSource).toHaveBeenCalledTimes(1);
      expect(enqueueSource).toHaveBeenCalledWith({
        projectRoot,
        document: result,
        projectRelativePath: 'assets/page.png'
      });
      expect(events).toEqual(['write:entries', 'enqueue:assets/page.png']);
      expect(result.entries['assets/page.png']?.regions).toHaveLength(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not sync rendered artifacts when the feedback write is rejected', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-write-fail-'));
    try {
      const renderScheduler = createScheduler();
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument: async () => {
          throw new Error('write conflict');
        }
      });

      await expect(service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-region',
        projectRelativePath: 'assets/page.png',
        region: {
          kind: 'pin',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      })).rejects.toThrow('write conflict');

      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects local feedback regions for non-image targets before writing feedback', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-'));
    try {
      const renderScheduler = createScheduler();
      const writeStructuredDocument = vi.fn(async () => undefined);
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument
      });

      await expect(service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-region',
        projectRelativePath: 'copy.md',
        region: {
          kind: 'pin',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      })).rejects.toThrow('Canvas feedback local regions require an image file: copy.md');

      expect(writeStructuredDocument).not.toHaveBeenCalled();
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows file-level feedback for non-image targets without queueing local artifact rendering', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-entry-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify(emptyFeedbackDocument());
      const writeStructuredDocument = vi.fn(async (_projectRoot, _absolutePath, content: string) => {
        currentContent = content;
      });
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => currentContent,
        writeStructuredDocument
      });

      const marksResult = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'set-marks',
        projectRelativePath: 'copy.md',
        marks: ['needs_revision']
      });
      const commentResult = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-comment',
        projectRelativePath: 'copy.md',
        comment: 'revise copy'
      });

      expect(marksResult.entries['copy.md']).toMatchObject({
        marks: ['needs_revision'],
        comments: [],
        regions: []
      });
      expect(commentResult.entries['copy.md']).toMatchObject({
        marks: ['needs_revision'],
        comments: [{
          comment: 'revise copy',
          createdAt: NOW,
          updatedAt: NOW
        }],
        regions: []
      });
      expect(writeStructuredDocument).toHaveBeenCalledTimes(2);
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not queue rendered artifacts for text-only feedback updates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-comment-only-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify(feedbackDocument({
        'assets/page.png': imageEntry()
      }));
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => currentContent,
        writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
          currentContent = content;
        }
      });

      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'update-region',
        projectRelativePath: 'assets/page.png',
        regionId: 'region-1',
        comment: 'new region comment'
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'set-marks',
        projectRelativePath: 'assets/page.png',
        marks: ['needs_revision']
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-comment',
        projectRelativePath: 'assets/page.png',
        comment: 'overall comment'
      });
      const fileCommentId = JSON.parse(currentContent).entries['assets/page.png'].comments[0].id as string;
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'update-comment',
        projectRelativePath: 'assets/page.png',
        commentId: fileCommentId,
        comment: 'updated overall comment'
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'delete-comment',
        projectRelativePath: 'assets/page.png',
        commentId: fileCommentId
      });

      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects text-only feedback writes when the current document has invalid local regions elsewhere', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-current-invalid-text-'));
    try {
      const renderScheduler = createScheduler();
      const writeStructuredDocument = vi.fn(async () => undefined);
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => JSON.stringify(feedbackDocument({
          'copy.md': {
            ...imageEntry(),
            projectRelativePath: 'copy.md'
          }
        })),
        writeStructuredDocument
      });

      await expect(service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-comment',
        projectRelativePath: 'assets/page.png',
        comment: 'overall comment'
      })).rejects.toThrow('Canvas feedback local regions require an image file: copy.md');
      expect(writeStructuredDocument).not.toHaveBeenCalled();
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('queues rendered artifacts for geometry-affecting feedback updates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-geometry-update-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify(feedbackDocument({
        'assets/page.png': imageEntry()
      }));
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => currentContent,
        writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
          currentContent = content;
        }
      });

      const result = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'update-region',
        projectRelativePath: 'assets/page.png',
        regionId: 'region-1',
        geometry: { type: 'point', x: 0.4, y: 0.5 }
      });

      expect(renderScheduler.enqueueSource).toHaveBeenCalledWith({
        projectRoot,
        document: result,
        projectRelativePath: 'assets/page.png'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('renders the current feedback entry when its source image changes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-source-'));
    try {
      const renderScheduler = createScheduler();
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => JSON.stringify(feedbackDocument({
          'assets/page.png': imageEntry()
        }))
      });

      await service.queueRenderedFeedbackForSource(projectRoot, 'assets/page.png');

      expect(renderScheduler.enqueueSource).toHaveBeenCalledWith({
        projectRoot,
        document: expect.objectContaining({ entries: expect.any(Object) }),
        projectRelativePath: 'assets/page.png'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('syncs the current feedback document when the feedback file changes externally', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-document-'));
    try {
      const renderScheduler = createScheduler();
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => JSON.stringify(feedbackDocument({
          'assets/page.png': imageEntry()
        }))
      });

      await service.queueRenderedFeedbackDocument(projectRoot);

      expect(renderScheduler.enqueueDocument).toHaveBeenCalledWith({
        projectRoot,
        document: expect.objectContaining({ entries: expect.any(Object) })
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects externally edited local regions for non-image targets before queueing renders', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-document-non-image-'));
    try {
      const renderScheduler = createScheduler();
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => JSON.stringify(feedbackDocument({
          'copy.md': {
            ...imageEntry(),
            projectRelativePath: 'copy.md'
          }
        }))
      });

      await expect(service.queueRenderedFeedbackDocument(projectRoot)).rejects.toThrow(
        'Canvas feedback local regions require an image file: copy.md'
      );
      expect(renderScheduler.enqueueDocument).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid current feedback documents before source-image render reconciliation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-source-invalid-document-'));
    try {
      const renderScheduler = createScheduler();
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => JSON.stringify(feedbackDocument({
          'copy.md': {
            ...imageEntry(),
            projectRelativePath: 'copy.md'
          }
        }))
      });

      await expect(service.queueRenderedFeedbackForSource(projectRoot, 'assets/page.png')).rejects.toThrow(
        'Canvas feedback local regions require an image file: copy.md'
      );
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function emptyFeedbackDocument(): object {
  return {
    updatedAt: NOW,
    entries: {}
  };
}

function feedbackDocument(entries: Record<string, object>): object {
  return {
    updatedAt: NOW,
    entries
  };
}

function imageEntry(): object {
  return {
    projectRelativePath: 'assets/page.png',
    marks: [],
    comments: [],
    nextRegionLabel: 2,
    regions: [{
      id: 'region-1',
      label: 1,
      kind: 'pin',
      geometry: { type: 'point', x: 0.2, y: 0.3 },
      comment: 'fix this',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}

function createScheduler(overrides: Partial<CanvasFeedbackRenderScheduler> = {}): CanvasFeedbackRenderScheduler {
  return {
    enqueueDocument: vi.fn(),
    enqueueSource: vi.fn(),
    cancelProject: vi.fn(),
    dispose: vi.fn(async () => undefined),
    ...overrides
  };
}
