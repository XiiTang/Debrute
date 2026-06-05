import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuTarget } from '../shell/contextMenu';
import { handleProjectTreeKeyboardEvent, ProjectTree } from './ProjectTree';
import type { ProjectTreeFileKeyboardCommand } from './projectTreeKeyboardCommands';

describe('ProjectTree', () => {
  it('renders selected project files', () => {
    const html = renderToStaticMarkup(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'briefs/concept.md' },
            { kind: 'file', projectRelativePath: 'assets/cover.png' },
            { kind: 'file', projectRelativePath: 'archive.bin' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selectedPath="briefs/concept.md"
        actions={actions}
      />
    );

    expect(html).toContain('concept.md');
    expect(html).toContain('aria-selected="true"');
  });

  it('renders known binary files as project tree rows', () => {
    const html = renderToStaticMarkup(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'archive.bin' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selectedPath="archive.bin"
        actions={actions}
      />
    );

    expect(html).toContain('archive.bin');
  });

  it('marks file and directory rows as context menu targets', () => {
    const html = renderToStaticMarkup(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'briefs/concept.md' },
            { kind: 'file', projectRelativePath: 'assets/cover.png' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selectedPath="assets/cover.png"
        actions={actions}
      />
    );

    expect(html).toContain('data-project-tree-context-path="briefs"');
    expect(html).toContain('data-project-tree-context-path="briefs/concept.md"');
    expect(html).toContain('data-project-tree-context-path="assets"');
    expect(html).toContain('data-project-tree-context-path="assets/cover.png"');
  });

  it('renders cut rows and inline edit rows', () => {
    const html = renderToStaticMarkup(
      <ProjectTree
        snapshot={{
          files: [
            { kind: 'file', projectRelativePath: 'assets/cover.png' },
            { kind: 'file', projectRelativePath: 'assets/page.png' }
          ]
        } as WorkbenchProjectSessionSnapshot}
        selectedPath="assets/cover.png"
        cutPath="assets/page.png"
        editing={{
          kind: 'creating-file',
          parentProjectRelativePath: 'assets',
          value: 'new.md'
        }}
        actions={actions}
      />
    );

    expect(html).toContain('project-tree-row cut');
    expect(html).toContain('data-project-tree-edit-kind="creating-file"');
    expect(html).toContain('value="new.md"');
  });

  it('dispatches keyboard file commands to the selected Project Tree target', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const event = keyboardEvent({ key: 'Delete' });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selectedNode: { kind: 'file', name: 'cover.png', path: 'assets/cover.png' },
      desktopPlatform: 'linux',
      onKeyboardFileCommand: (command, target) => commands.push({ command, target })
    });

    expect(commands).toEqual([{
      command: 'delete',
      target: {
        source: 'explorer',
        kind: 'file',
        projectRelativePath: 'assets/cover.png'
      }
    }]);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it('clears cut state without dispatching a file command on Escape', () => {
    const commands: Array<{ command: ProjectTreeFileKeyboardCommand; target: WorkbenchContextMenuTarget }> = [];
    const onClearCut = vi.fn();
    const event = keyboardEvent({ key: 'Escape' });

    handleProjectTreeKeyboardEvent({
      event,
      editing: undefined,
      selectedNode: { kind: 'directory', name: 'assets', path: 'assets', children: [] },
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

const actions = {
  selectExplorerPath: () => undefined
} as unknown as WorkbenchActions;

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
