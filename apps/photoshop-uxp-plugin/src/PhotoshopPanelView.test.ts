import { describe, expect, it } from 'vitest';
import {
  destinationTreePresentation,
  panelPresentation
} from './PhotoshopPanelView.js';
import type { PhotoshopPluginSnapshot } from './PhotoshopPluginRuntime.js';

describe('PhotoshopPanelView presentation', () => {
  it('enables one direct send action only for a connected valid idle destination', () => {
    expect(panelPresentation(snapshotFixture())).toEqual({
      connectionLabel: 'Connected',
      sourceLabel: 'Poster.psd · 1 selected',
      sourceProblem: null,
      destinationLabel: 'Poster / exports',
      destinationStatus: 'valid',
      sendLabel: 'Send 1 file',
      sendDisabled: false
    });
  });

  it('keeps the admitted item count and destination in the busy presentation', () => {
    expect(panelPresentation({
      ...snapshotFixture(),
      selection: {
        documentId: 4,
        documentTitle: 'Poster.psd',
        items: []
      },
      destination: {
        canonicalRoot: 'project-2',
        projectName: 'Campaign',
        projectRevision: 7,
        directory: 'next'
      },
      activeExport: { itemCount: 3, destinationLabel: 'Poster / exports' },
      busy: true
    })).toMatchObject({
      sourceLabel: 'Poster.psd · Select layers or groups',
      destinationLabel: 'Campaign / next',
      sendLabel: 'Sending 3 files to Poster / exports…',
      sendDisabled: true
    });
  });

  it('derives one naturally ordered visible tree with independent duplicate basenames and inline loading', () => {
    expect(destinationTreePresentation({
      ...snapshotFixture(),
      projects: [
        { canonicalRoot: 'project-10', name: 'Project 10', revision: 3 },
        { canonicalRoot: 'project-2', name: 'Project 2', revision: 5 }
      ],
      directoryTrees: [
        {
          canonicalRoot: 'project-10',
          projectRevision: 3,
          status: 'loaded',
          directories: ['', 'folder10', 'folder2', 'one', 'one/shared', 'two', 'two/shared']
        },
        {
          canonicalRoot: 'project-2',
          projectRevision: 5,
          status: 'loading',
          directories: []
        }
      ],
      expandedDirectories: [
        { canonicalRoot: 'project-2', directory: '' },
        { canonicalRoot: 'project-10', directory: '' },
        { canonicalRoot: 'project-10', directory: 'one' },
        { canonicalRoot: 'project-10', directory: 'two' }
      ],
      destination: {
        canonicalRoot: 'project-10',
        projectName: 'Project 10',
        projectRevision: 3,
        directory: 'one/shared'
      }
    }).roots).toMatchObject([
      {
        kind: 'project',
        canonicalRoot: 'project-2',
        directory: '',
        label: 'Project 2',
        depth: 0,
        expanded: true,
        children: [{ kind: 'loading', label: 'Loading directories…', depth: 1 }]
      },
      {
        kind: 'project',
        canonicalRoot: 'project-10',
        directory: '',
        label: 'Project 10',
        depth: 0,
        expanded: true,
        children: [
          { kind: 'directory', label: 'folder2', directory: 'folder2' },
          { kind: 'directory', label: 'folder10', directory: 'folder10' },
          {
            kind: 'directory',
            label: 'one',
            directory: 'one',
            expanded: true,
            children: [{ kind: 'directory', label: 'shared', directory: 'one/shared', selected: true }]
          },
          {
            kind: 'directory',
            label: 'two',
            directory: 'two',
            expanded: true,
            children: [{ kind: 'directory', label: 'shared', directory: 'two/shared', selected: false }]
          }
        ]
      }
    ]);
  });

  it('shows an expanded empty Project without an invented empty child', () => {
    const snapshot = snapshotFixture();
    expect(destinationTreePresentation({
      ...snapshot,
      directoryTrees: [{
        canonicalRoot: 'project-1',
        projectRevision: 2,
        status: 'loaded',
        directories: ['']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
      destination: { ...snapshot.destination!, directory: '' }
    }).roots[0]).toMatchObject({ expanded: true, children: [] });
  });

  it('uses case-insensitive natural order without moving exact selection on projection reorder', () => {
    const snapshot = snapshotFixture();
    const reordered = destinationTreePresentation({
      ...snapshot,
      projects: [
        { canonicalRoot: 'project-b', name: 'projectB', revision: 1 },
        { canonicalRoot: 'project-a', name: 'Projecta', revision: 1 }
      ],
      directoryTrees: [{
        canonicalRoot: 'project-b',
        projectRevision: 1,
        status: 'loaded',
        directories: ['', 'folder10', 'Folder2', 'folder1']
      }],
      expandedDirectories: [{ canonicalRoot: 'project-b', directory: '' }],
      destination: {
        canonicalRoot: 'project-b',
        projectName: 'projectB',
        projectRevision: 1,
        directory: 'Folder2'
      }
    });

    expect(reordered.roots.map((root) => root.label)).toEqual(['Projecta', 'projectB']);
    expect(reordered.roots[1]?.children.map((child) => child.label)).toEqual([
      'folder1',
      'Folder2',
      'folder10'
    ]);
    expect(reordered.roots[1]?.children[1]).toMatchObject({
      directory: 'Folder2',
      selected: true
    });
  });

  it('keeps a disconnected candidate visible as pending while the live tree is absent', () => {
    const snapshot = {
      ...snapshotFixture(),
      connection: { status: 'disconnected' as const },
      projects: [],
      directoryTrees: []
    };

    expect(panelPresentation(snapshot)).toMatchObject({
      connectionLabel: 'Disconnected',
      destinationLabel: 'Poster / exports',
      destinationStatus: 'pending',
      sendDisabled: true
    });
    expect(destinationTreePresentation(snapshot).roots).toEqual([]);
  });

  it('disables send when there is no exact destination or the selection exceeds 50 items', () => {
    const items = Array.from({ length: 51 }, (_, index) => ({
      layerId: index,
      name: `Layer ${index}`,
      kind: 'layer' as const
    }));
    expect(panelPresentation({
      ...snapshotFixture(),
      connection: { status: 'disconnected' },
      selection: { documentId: 4, documentTitle: 'Poster.psd', items },
      destination: null
    })).toMatchObject({
      connectionLabel: 'Disconnected',
      sourceLabel: 'Poster.psd · 51 selected',
      sourceProblem: 'Select no more than 50 layers or groups.',
      destinationLabel: 'No destination selected',
      destinationStatus: 'empty',
      sendDisabled: true
    });
  });
});

function snapshotFixture(): PhotoshopPluginSnapshot {
  return {
    connection: { status: 'ready', runtimeInstanceId: 'runtime-1', pluginSessionId: 'session-1' },
    selection: {
      documentId: 4,
      documentTitle: 'Poster.psd',
      items: [{ layerId: 8, name: 'Hero', kind: 'layer' }]
    },
    projects: [{ canonicalRoot: 'project-1', name: 'Poster', revision: 2 }],
    directoryTrees: [{
      canonicalRoot: 'project-1',
      projectRevision: 2,
      status: 'loaded',
      directories: ['', 'exports']
    }],
    expandedDirectories: [{ canonicalRoot: 'project-1', directory: '' }],
    destination: {
      canonicalRoot: 'project-1',
      projectName: 'Poster',
      projectRevision: 2,
      directory: 'exports'
    },
    activeExport: null,
    busy: false,
    result: null
  };
}
