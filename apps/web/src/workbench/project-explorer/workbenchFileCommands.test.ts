import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import { describe, expect, it } from 'vitest';
import type { WorkbenchFileClipboard } from '../shell/contextMenu';
import {
  batchResultSelectionPaths,
  clearClipboardAfterDeletedPath,
  clearClipboardAfterPaste,
  clearCanvasSelectionAfterDeletedPath,
  externalDropPlanHasConflict,
  nearestExistingParentSelection,
  permanentDeleteConfirmationMessage,
  projectTreeSelectionFromPaths,
  reconcileCutClipboardWithProjectEntries,
  rewriteCanvasSelectionAfterPathChanges,
  singleFileBatchResultPath
} from './workbenchFileCommands';

describe('workbench file command helpers', () => {
  it('creates a stable tree selection from ordered paths', () => {
    expect(projectTreeSelectionFromPaths(['a.md', 'b.md'])).toEqual({
      selectedPaths: ['a.md', 'b.md'],
      focusedPath: 'b.md',
      anchorPath: 'b.md'
    });
  });

  it('locates only one completed file result', () => {
    expect(singleFileBatchResultPath([{
      sourceProjectRelativePath: 'a.md',
      projectRelativePath: 'target/a.md',
      kind: 'file',
      status: 'ok'
    }])).toBe('target/a.md');
  });

  it('detects top-level external-drop conflicts', () => {
    expect(externalDropPlanHasConflict({
      snapshot: snapshotWithFiles(['assets/photo.png']),
      localPaths: ['/tmp/photo.png'],
      uploads: [],
      targetDirectoryProjectRelativePath: 'assets'
    })).toBe(true);
  });

  it('clears only completed cut clipboards after paste', () => {
    const copy: WorkbenchFileClipboard = { operation: 'copy', entries: [{ projectRelativePath: 'a.md', kind: 'file' }] };
    const cut: WorkbenchFileClipboard = { operation: 'cut', entries: [{ projectRelativePath: 'a.md', kind: 'file' }] };

    expect(clearClipboardAfterPaste(copy)).toBe(copy);
    expect(clearClipboardAfterPaste(cut)).toBeUndefined();
  });

  it('finds the nearest existing parent selection after deletion', () => {
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['assets', 'assets/pages']))).toBe('assets/pages');
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['assets']))).toBe('assets');
    expect(nearestExistingParentSelection('assets/pages/page.png', new Set(['briefs']))).toBeUndefined();
  });

  it('clears Canvas node selections for deleted project paths', () => {
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'nodes', projectRelativePaths: ['assets/pages/page.png'] }, 'assets')).toBeUndefined();
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'nodes', projectRelativePaths: ['assets/pages/page.png'] }, 'assets/pages/page.png')).toBeUndefined();
    expect(clearCanvasSelectionAfterDeletedPath({ kind: 'nodes', projectRelativePaths: ['briefs/concept.md'] }, 'assets')).toEqual({ kind: 'nodes', projectRelativePaths: ['briefs/concept.md'] });
    expect(clearCanvasSelectionAfterDeletedPath({
      kind: 'nodes',
      projectRelativePaths: ['assets/cover.png', 'briefs/concept.md']
    }, 'assets')).toEqual({ kind: 'nodes', projectRelativePaths: ['briefs/concept.md'] });
  });

  it('keeps Canvas selection attached to Runtime-confirmed renamed and moved paths', () => {
    expect(rewriteCanvasSelectionAfterPathChanges({
      kind: 'nodes',
      projectRelativePaths: ['assets', 'assets/pages/page.png', 'brief.md']
    }, [{
      sourceProjectRelativePath: 'assets',
      projectRelativePath: 'archive/assets',
      status: 'ok'
    }])).toEqual({
      kind: 'nodes',
      projectRelativePaths: ['archive/assets', 'archive/assets/pages/page.png', 'brief.md']
    });
  });

  it('clears clipboard sources affected by deleted paths', () => {
    const source: WorkbenchFileClipboard = {
      operation: 'copy',
      entries: [
        { projectRelativePath: 'assets/pages/page.png', kind: 'file' },
        { projectRelativePath: 'briefs/concept.md', kind: 'file' }
      ]
    };

    expect(clearClipboardAfterDeletedPath(source, 'assets')).toEqual({
      operation: 'copy',
      entries: [
        { projectRelativePath: 'briefs/concept.md', kind: 'file' }
      ]
    });
    expect(clearClipboardAfterDeletedPath(source, 'assets/pages/page.png')).toEqual({
      operation: 'copy',
      entries: [
        { projectRelativePath: 'briefs/concept.md', kind: 'file' }
      ]
    });
    expect(clearClipboardAfterDeletedPath(source, 'rules')).toBe(source);
  });

  it('reconciles only Cut roots with current Project entry identity', () => {
    const cut: WorkbenchFileClipboard = {
      operation: 'cut',
      entries: [
        { projectRelativePath: 'assets', kind: 'directory' },
        { projectRelativePath: 'brief.md', kind: 'file' }
      ]
    };
    const copy: WorkbenchFileClipboard = { ...cut, operation: 'copy' };

    expect(reconcileCutClipboardWithProjectEntries(cut, [
      { projectRelativePath: 'assets', kind: 'file' },
      { projectRelativePath: 'brief.md', kind: 'file' }
    ])).toEqual({
      operation: 'cut',
      entries: [{ projectRelativePath: 'brief.md', kind: 'file' }]
    });
    expect(reconcileCutClipboardWithProjectEntries(copy, [])).toBe(copy);
  });

  it('keeps successful and skipped batch result paths selected', () => {
    expect(batchResultSelectionPaths([
      {
        sourceProjectRelativePath: 'cover.png',
        projectRelativePath: 'assets/cover.png',
        kind: 'file',
        status: 'ok'
      },
      {
        sourceProjectRelativePath: 'assets/skip.md',
        projectRelativePath: 'assets/skip.md',
        kind: 'file',
        status: 'skipped'
      }
    ])).toEqual(['assets/cover.png', 'assets/skip.md']);
  });

  it('formats permanent delete confirmations by target kind', () => {
    expect(permanentDeleteConfirmationMessage({
      projectRelativePath: 'assets',
      kind: 'directory'
    }, permanentDeleteLabels)).toBe('Permanently delete directory "assets"? This cannot be undone.');
    expect(permanentDeleteConfirmationMessage({
      projectRelativePath: 'briefs/concept.md',
      kind: 'file'
    }, permanentDeleteLabels)).toBe('Permanently delete file "briefs/concept.md"? This cannot be undone.');
  });

});

const permanentDeleteLabels = {
  directory: (path: string) => `Permanently delete directory "${path}"? This cannot be undone.`,
  file: (path: string) => `Permanently delete file "${path}"? This cannot be undone.`,
  selectedItems: (count: number) => `Permanently delete ${count} selected items? This cannot be undone.`
};

function snapshotWithFiles(paths: string[]): WorkbenchProjectSessionSnapshot {
  return {
    canonicalRoot: '/projects/project-1',
    canvasWorkspace: {
      status: 'available',
      workspace: {
        canonicalRoot: '/projects/project-1',
        expandedDirectories: [],
        nodeStates: {},
        occlusionOrder: []
      },
      canvasResources: { resources: [] },
      feedbackVideoResources: { resources: [] }
    },
    projectTree: paths.map((projectRelativePath) => ({
      projectRelativePath,
      kind: 'file' as const
    })),
    diagnostics: [],
    health: {
      projectName: 'Demo',
      diagnosticCounts: { errors: 0, warnings: 0 },
      checkedAt: '2026-07-10T00:00:00.000Z'
    }
  };
}
