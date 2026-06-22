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
          events.push(`write:${JSON.parse(content).schemaVersion}`);
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
      expect(events).toEqual(['write:2', 'enqueue:assets/page.png']);
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
        projectRelativePath: 'notes.md',
        region: {
          kind: 'pin',
          geometry: { type: 'point', x: 0.2, y: 0.3 },
          comment: 'fix this'
        }
      })).rejects.toThrow('Canvas feedback local regions require an image file: notes.md');

      expect(writeStructuredDocument).not.toHaveBeenCalled();
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('allows image-level feedback for non-image targets without queueing local artifact rendering', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-non-image-entry-'));
    try {
      const renderScheduler = createScheduler();
      const writeStructuredDocument = vi.fn(async () => undefined);
      const service = createCanvasFeedbackService({
        now: () => NOW,
        renderScheduler,
        writeStructuredDocument
      });

      const result = await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'set-entry',
        projectRelativePath: 'notes.md',
        marks: ['needs_revision'],
        note: 'revise copy'
      });

      expect(result.entries['notes.md']).toMatchObject({
        marks: ['needs_revision'],
        note: 'revise copy',
        regions: []
      });
      expect(writeStructuredDocument).toHaveBeenCalledTimes(1);
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not queue rendered artifacts for comment-only feedback updates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-comment-only-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify({
        schemaVersion: 2,
        updatedAt: NOW,
        entries: {
          'assets/page.png': {
            projectRelativePath: 'assets/page.png',
            marks: [],
            note: '',
            nextRegionLabel: 2,
            regions: [{
              id: 'region-1',
              label: 1,
              kind: 'pin',
              geometry: { type: 'point', x: 0.2, y: 0.3 },
              comment: 'old comment',
              createdAt: NOW,
              updatedAt: NOW
            }],
            updatedAt: NOW
          }
        }
      });
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
        comment: 'new comment'
      });
      await service.updateCanvasFeedbackEntry(projectRoot, {
        operation: 'set-entry',
        projectRelativePath: 'assets/page.png',
        marks: ['needs_revision'],
        note: 'overall note'
      });

      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('queues rendered artifacts for geometry-affecting feedback updates', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-feedback-geometry-update-'));
    try {
      const renderScheduler = createScheduler();
      let currentContent = JSON.stringify({
        schemaVersion: 2,
        updatedAt: NOW,
        entries: {
          'assets/page.png': {
            projectRelativePath: 'assets/page.png',
            marks: [],
            note: '',
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
          }
        }
      });
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
        readStructuredDocument: async () => JSON.stringify({
          schemaVersion: 2,
          updatedAt: NOW,
          entries: {
            'assets/page.png': {
              projectRelativePath: 'assets/page.png',
              marks: [],
              note: '',
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
            }
          }
        })
      });

      await service.queueRenderedFeedbackForSource(projectRoot, 'assets/page.png');

      expect(renderScheduler.enqueueSource).toHaveBeenCalledWith({
        projectRoot,
        document: expect.objectContaining({ schemaVersion: 2 }),
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
        readStructuredDocument: async () => JSON.stringify({
          schemaVersion: 2,
          updatedAt: NOW,
          entries: {
            'assets/page.png': {
              projectRelativePath: 'assets/page.png',
              marks: [],
              note: '',
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
            }
          }
        })
      });

      await service.queueRenderedFeedbackDocument(projectRoot);

      expect(renderScheduler.enqueueDocument).toHaveBeenCalledWith({
        projectRoot,
        document: expect.objectContaining({ schemaVersion: 2 })
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
        readStructuredDocument: async () => JSON.stringify({
          schemaVersion: 2,
          updatedAt: NOW,
          entries: {
            'notes.md': {
              projectRelativePath: 'notes.md',
              marks: [],
              note: '',
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
            }
          }
        })
      });

      await expect(service.queueRenderedFeedbackDocument(projectRoot)).rejects.toThrow(
        'Canvas feedback local regions require an image file: notes.md'
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
        readStructuredDocument: async () => JSON.stringify({
          schemaVersion: 2,
          updatedAt: NOW,
          entries: {
            'notes.md': {
              projectRelativePath: 'notes.md',
              marks: [],
              note: '',
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
            }
          }
        })
      });

      await expect(service.queueRenderedFeedbackForSource(projectRoot, 'assets/page.png')).rejects.toThrow(
        'Canvas feedback local regions require an image file: notes.md'
      );
      expect(renderScheduler.enqueueSource).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function createScheduler(overrides: Partial<CanvasFeedbackRenderScheduler> = {}): CanvasFeedbackRenderScheduler {
  return {
    enqueueDocument: vi.fn(),
    enqueueSource: vi.fn(),
    cancelProject: vi.fn(),
    dispose: vi.fn(async () => undefined),
    ...overrides
  };
}
