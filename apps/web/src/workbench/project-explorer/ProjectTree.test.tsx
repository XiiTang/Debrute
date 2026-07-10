import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchContextMenuTarget } from '../shell/contextMenu';
import {
  handleProjectTreeKeyboardEvent,
  handleProjectTreeRootContextMenuEvent,
  isRootBlankAreaEventTarget,
  projectTreeRowClickAction,
  ProjectTree
} from './ProjectTree';
import { flattenProjectTree, type ProjectTreeSelectionState } from './projectTreeInteraction';
import { buildProjectFileTree } from './projectFileTree';
import type { ProjectTreeFileKeyboardCommand } from './projectTreeKeyboardCommands';
import { I18nProvider } from '../i18n';

function renderStaticWithI18n(element: ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      {element}
    </I18nProvider>
  );
}

describe('ProjectTree', () => {
  it('renders selected project files', () => {
    const html = renderStaticWithI18n(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'briefs/concept.md' },
            { kind: 'file', projectRelativePath: 'assets/cover.png' },
            { kind: 'file', projectRelativePath: 'archive.bin' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selection={selection(['briefs/concept.md'])}
        cutPaths={[]}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('concept.md');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('db-tree-row');
  });

  it('activates directories on a plain click without requiring a prior selection', () => {
    expect(projectTreeRowClickAction({
      kind: 'directory',
      platform: 'linux',
      event: {}
    })).toEqual({
      toggleDirectory: true,
      locateFileInCanvas: false
    });
  });

  it('keeps modified directory clicks available for selection without expanding', () => {
    expect(projectTreeRowClickAction({
      kind: 'directory',
      platform: 'linux',
      event: { ctrlKey: true }
    })).toEqual({
      toggleDirectory: false,
      locateFileInCanvas: false
    });
  });

  it('locates files on a plain click', () => {
    expect(projectTreeRowClickAction({
      kind: 'file',
      platform: 'darwin',
      event: {}
    })).toEqual({
      toggleDirectory: false,
      locateFileInCanvas: true
    });
  });

  it('renders the empty Project Tree state through shared UI classes', () => {
    const html = renderStaticWithI18n(
      <ProjectTree
        snapshot={{ files: [] } as unknown as WorkbenchProjectSessionSnapshot}
        selection={selection([])}
        cutPaths={[]}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('db-empty-state');
    expect(html).toContain('No project files');
  });

  it('renders known binary files as project tree rows', () => {
    const html = renderStaticWithI18n(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'archive.bin' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selection={selection(['archive.bin'])}
        cutPaths={[]}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('archive.bin');
  });

  it('marks file and directory rows as context menu targets', () => {
    const html = renderStaticWithI18n(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'briefs/concept.md' },
            { kind: 'file', projectRelativePath: 'assets/cover.png' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selection={selection(['assets/cover.png', 'briefs/concept.md'])}
        cutPaths={[]}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('data-project-tree-context-path="briefs"');
    expect(html).toContain('data-project-tree-context-path="briefs/concept.md"');
    expect(html).toContain('data-project-tree-context-path="assets"');
    expect(html).toContain('data-project-tree-context-path="assets/cover.png"');
  });

  it('renders cut rows and inline edit rows', () => {
    const html = renderStaticWithI18n(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'assets/cover.png' },
            { kind: 'file', projectRelativePath: 'assets/page.png' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selection={selection(['assets/cover.png'])}
        cutPaths={['assets/page.png']}
        editing={{
          kind: 'creating-file',
          parentProjectRelativePath: 'assets',
          value: 'new.md'
        }}
        onSelectionChange={() => undefined}
      />
    );

    expect(html).toContain('project-tree-row cut');
    expect(html).toContain('data-project-tree-edit-kind="creating-file"');
    expect(html).toContain('class="project-tree-edit-row"');
    expect(html).toContain('value="new.md"');
  });

  it('dispatches keyboard file commands to the selected Project Tree target', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const event = keyboardEvent({ key: 'Delete' });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selection: selection(['assets/cover.png']),
      visibleItems: flattenProjectTree(buildProjectFileTree([
        { kind: 'file', projectRelativePath: 'assets/cover.png' }
      ]), new Set(['assets'])),
      desktopPlatform: 'linux',
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([{
      command: 'delete',
      target: {
        source: 'explorer',
        targetKind: 'item',
        paths: [{ projectRelativePath: 'assets/cover.png', kind: 'file' }],
        primaryPath: 'assets/cover.png',
        targetDirectoryPath: 'assets'
      }
    }]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('uses the focused item to resolve keyboard paste targets for multi-selection', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const event = keyboardEvent({ key: 'v', ctrlKey: true });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selection: {
        selectedPaths: ['assets', 'briefs/concept.md'],
        focusedPath: 'briefs/concept.md',
        anchorPath: 'assets'
      },
      visibleItems: flattenProjectTree(buildProjectFileTree([
        { kind: 'file', projectRelativePath: 'assets/cover.png' },
        { kind: 'file', projectRelativePath: 'briefs/concept.md' }
      ]), new Set(['assets', 'briefs'])),
      desktopPlatform: 'linux',
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([{
      command: 'paste',
      target: {
        source: 'explorer',
        targetKind: 'selection',
        paths: [
          { projectRelativePath: 'assets', kind: 'directory' },
          { projectRelativePath: 'briefs/concept.md', kind: 'file' }
        ],
        primaryPath: 'assets',
        targetDirectoryPath: 'briefs'
      }
    }]);
  });

  it('treats the empty Project Tree placeholder as blank root space', () => {
    const emptyLine = {
      closest: vi.fn((selector: string) => selector === '[data-project-tree-empty-line]' ? emptyLine : null)
    };
    const root = {};

    expect(isRootBlankAreaEventTarget({
      target: emptyLine,
      currentTarget: root
    })).toBe(true);
  });

  it('opens the root context menu from Project Tree blank space', () => {
    const root = {};
    const preventDefault = vi.fn();
    const selections: ProjectTreeSelectionState[] = [];
    const onOpenContextMenu = vi.fn();

    expect(handleProjectTreeRootContextMenuEvent({
      event: {
        target: root,
        currentTarget: root,
        clientX: 12,
        clientY: 34,
        preventDefault
      },
      onSelectionChange: (next) => selections.push(next),
      onOpenContextMenu
    })).toBe(true);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(selections).toEqual([selection([])]);
    expect(onOpenContextMenu).toHaveBeenCalledWith({
      source: 'explorer',
      targetKind: 'root',
      paths: [],
      primaryPath: null,
      targetDirectoryPath: ''
    }, {
      x: 12,
      y: 34
    });
  });

  it('ignores item keyboard commands when the Project Tree selection is empty', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const event = keyboardEvent({ key: 'c', ctrlKey: true });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selection: selection([]),
      visibleItems: flattenProjectTree(buildProjectFileTree([
        { kind: 'file', projectRelativePath: 'assets/cover.png' }
      ]), new Set(['assets'])),
      desktopPlatform: 'linux',
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([]);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it('keeps keyboard paste available for the Project Tree root when selection is empty', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const event = keyboardEvent({ key: 'v', ctrlKey: true });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selection: selection([]),
      visibleItems: flattenProjectTree(buildProjectFileTree([
        { kind: 'file', projectRelativePath: 'assets/cover.png' }
      ]), new Set(['assets'])),
      desktopPlatform: 'linux',
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([{
      command: 'paste',
      target: {
        source: 'explorer',
        targetKind: 'root',
        paths: [],
        primaryPath: null,
        targetDirectoryPath: ''
      }
    }]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('does not handle bubbled row drag events as root drops', () => {
    const row = {
      closest: vi.fn(() => null)
    };
    const root = {};

    expect(isRootBlankAreaEventTarget({
      target: row,
      currentTarget: root
    })).toBe(false);
    expect(isRootBlankAreaEventTarget({
      target: root,
      currentTarget: root
    })).toBe(true);
  });

  it('moves Project Tree focus with arrow keys', () => {
    const events = [
      keyboardEvent({ key: 'ArrowDown' }),
      keyboardEvent({ key: 'ArrowRight' }),
      keyboardEvent({ key: 'ArrowLeft' })
    ];
    const selections: ProjectTreeSelectionState[] = [];
    const expandedChanges: Set<string>[] = [];
    const expanded = new Set(['assets']);
    const collapsed = new Set<string>();
    const visibleItems = flattenProjectTree(buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/cover.png' },
      { kind: 'file', projectRelativePath: 'briefs/concept.md' }
    ]), expanded);
    const collapsedVisibleItems = flattenProjectTree(buildProjectFileTree([
      { kind: 'file', projectRelativePath: 'assets/cover.png' },
      { kind: 'file', projectRelativePath: 'briefs/concept.md' }
    ]), collapsed);

    handleProjectTreeKeyboardEvent({
      event: events[0]!,
      editing: undefined,
      selection: selection(['assets']),
      visibleItems,
      expanded,
      desktopPlatform: 'linux',
      onSelectionChange: (next) => selections.push(next),
      onExpandedChange: (next) => expandedChanges.push(next)
    });
    handleProjectTreeKeyboardEvent({
      event: events[1]!,
      editing: undefined,
      selection: selection(['assets']),
      visibleItems: collapsedVisibleItems,
      expanded: collapsed,
      desktopPlatform: 'linux',
      onSelectionChange: (next) => selections.push(next),
      onExpandedChange: (next) => expandedChanges.push(next)
    });
    handleProjectTreeKeyboardEvent({
      event: events[2]!,
      editing: undefined,
      selection: selection(['assets']),
      visibleItems,
      expanded,
      desktopPlatform: 'linux',
      onSelectionChange: (next) => selections.push(next),
      onExpandedChange: (next) => expandedChanges.push(next)
    });

    expect(selections).toEqual([
      selection(['assets/cover.png'])
    ]);
    expect([...(expandedChanges[0] ?? [])]).toEqual(['assets']);
    expect([...(expandedChanges[1] ?? [])]).toEqual([]);
    expect(events[0]!.preventDefault).toHaveBeenCalledTimes(1);
    expect(events[1]!.preventDefault).toHaveBeenCalledTimes(1);
    expect(events[2]!.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('clears cut state without dispatching a file command on Escape', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const onClearCut = vi.fn();
    const event = keyboardEvent({ key: 'Escape' });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selection: selection(['assets']),
      visibleItems: flattenProjectTree(buildProjectFileTree([
        { kind: 'directory', projectRelativePath: 'assets' }
      ]), new Set(['assets'])),
      desktopPlatform: 'darwin',
      onClearCut,
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([]);
    expect(onClearCut).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

function selection(selectedPaths: string[]): ProjectTreeSelectionState {
  return {
    selectedPaths,
    focusedPath: selectedPaths.at(-1) ?? null,
    anchorPath: selectedPaths.at(-1) ?? null
  };
}

function keyboardEvent(input: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}) {
  return {
    ...input,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  };
}
