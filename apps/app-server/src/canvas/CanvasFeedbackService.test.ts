import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasFeedbackService } from './CanvasFeedbackService';
import type { CanvasFeedbackRenderScheduler } from './CanvasFeedbackArtifactScheduler';

const NOW = '2026-06-21T12:00:00.000Z';

describe('CanvasFeedbackService materialization', () => {
  it('writes accepted feedback before queueing artifacts for image spatial items', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-service-'));
    try {
      const events: string[] = [];
      const enqueueSource = vi.fn((input: Parameters<CanvasFeedbackRenderScheduler['enqueueSource']>[0]) => {
        events.push(`enqueue:${input.projectRelativePath}`);
      });
      const renderScheduler = createScheduler({ enqueueSource });
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
          const document = JSON.parse(content) as { entries?: unknown };
          events.push(`write:${document.entries && typeof document.entries === 'object' ? 'entries' : 'invalid'}`);
        }
      });

      const result = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-item',
        projectRelativePath: 'assets/page.png',
        item: {
          kind: 'pin',
          scope: 'file',
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
      expect(result.entries['assets/page.png']?.items).toHaveLength(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('queues artifacts for video moment comments and spatial items', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-video-moment-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify(emptyFeedbackDocument());
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        readStructuredDocument: async () => currentContent,
        writeStructuredDocument: async (_projectRoot, _absolutePath, content) => {
          currentContent = content;
        }
      });

      const momentComment = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-item',
        projectRelativePath: 'assets/clip.mp4',
        item: {
          kind: 'comment',
          scope: 'moment',
          momentTimeSeconds: 4.25,
          comment: 'pause here'
        }
      });
      const momentPin = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-item',
        projectRelativePath: 'assets/clip.mp4',
        item: {
          kind: 'pin',
          scope: 'moment',
          momentTimeSeconds: 4.25,
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'look here'
        }
      });

      expect(renderScheduler.enqueueSource).toHaveBeenCalledTimes(2);
      expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(1, {
        projectRoot,
        document: momentComment,
        projectRelativePath: 'assets/clip.mp4'
      });
      expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(2, {
        projectRoot,
        document: momentPin,
        projectRelativePath: 'assets/clip.mp4'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not sync artifacts when the feedback write is rejected', async () => {
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
        operation: 'add-item',
        projectRelativePath: 'assets/page.png',
        item: {
          kind: 'pin',
          scope: 'file',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      })).rejects.toThrow('write conflict');

      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects file-scope spatial items for non-image targets before writing feedback', async () => {
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
        operation: 'add-item',
        projectRelativePath: 'copy.md',
        item: {
          kind: 'pin',
          scope: 'file',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      })).rejects.toThrow('Canvas feedback file-scope spatial items require an image file: copy.md');

      expect(writeStructuredDocument).not.toHaveBeenCalled();
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects moment items for non-video targets before writing feedback', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-moment-non-video-'));
    try {
      const renderScheduler = createScheduler();
      const writeStructuredDocument = vi.fn(async () => undefined);
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument
      });

      await expect(service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-item',
        projectRelativePath: 'assets/page.png',
        item: {
          kind: 'comment',
          scope: 'moment',
          momentTimeSeconds: 2,
          comment: 'wrong target'
        }
      })).rejects.toThrow('Canvas feedback moment items require a video file: assets/page.png');

      expect(writeStructuredDocument).not.toHaveBeenCalled();
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows file-level feedback for non-image targets without queueing artifact rendering', async () => {
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
        operation: 'add-item',
        projectRelativePath: 'copy.md',
        item: { kind: 'comment', scope: 'file', comment: 'revise copy' }
      });

      expect(marksResult.entries['copy.md']).toMatchObject({
        marks: ['needs_revision'],
        items: []
      });
      expect(commentResult.entries['copy.md']).toMatchObject({
        marks: ['needs_revision'],
        items: [{
          kind: 'comment',
          scope: 'file',
          comment: 'revise copy',
          createdAt: NOW,
          updatedAt: NOW
        }]
      });
      expect(writeStructuredDocument).toHaveBeenCalledTimes(2);
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not queue artifacts for item text updates or mark updates', async () => {
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
        operation: 'update-item',
        projectRelativePath: 'assets/page.png',
        itemId: 'item-1',
        comment: 'new region comment'
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'set-marks',
        projectRelativePath: 'assets/page.png',
        marks: ['needs_revision']
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'add-item',
        projectRelativePath: 'assets/page.png',
        item: { kind: 'comment', scope: 'file', comment: 'overall comment' }
      });

      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('queues artifacts for geometry-affecting feedback updates and item deletion', async () => {
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

      const updateResult = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'update-item',
        projectRelativePath: 'assets/page.png',
        itemId: 'item-1',
        geometry: { type: 'point', x: 0.4, y: 0.5 }
      });
      const deleteResult = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'delete-item',
        projectRelativePath: 'assets/page.png',
        itemId: 'item-1'
      });

      expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(1, {
        projectRoot,
        document: updateResult,
        projectRelativePath: 'assets/page.png'
      });
      expect(renderScheduler.enqueueSource).toHaveBeenNthCalledWith(2, {
        projectRoot,
        document: deleteResult,
        projectRelativePath: 'assets/page.png'
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('renders the current feedback entry when its source changes', async () => {
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
          'assets/page.png': imageEntry(),
          'assets/clip.mp4': videoEntry()
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

  it('rejects externally edited invalid scopes before queueing renders', async () => {
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
        'Canvas feedback file-scope spatial items require an image file: copy.md'
      );
      expect(renderScheduler.enqueueDocument).not.toHaveBeenCalled();
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
    nextMomentLabel: 1,
    nextSpatialLabel: 2,
    items: [{
      id: 'item-1',
      kind: 'pin',
      scope: 'file',
      label: 1,
      geometry: { type: 'point', x: 0.2, y: 0.3 },
      comment: 'fix this',
      createdAt: NOW,
      updatedAt: NOW
    }],
    updatedAt: NOW
  };
}

function videoEntry(): object {
  return {
    projectRelativePath: 'assets/clip.mp4',
    marks: [],
    nextMomentLabel: 2,
    nextSpatialLabel: 1,
    items: [{
      id: 'item-1',
      kind: 'comment',
      scope: 'moment',
      moment: { label: 'M1', currentTimeSeconds: 4.25 },
      comment: 'pause here',
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
