import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import { ProjectTree } from './ProjectTree';

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
});

const actions = {
  selectExplorerPath: () => undefined
} as unknown as WorkbenchActions;
