import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOpenPanel } from './ProjectOpenPanel';

describe('ProjectOpenPanel', () => {
  it('submits the entered absolute path', () => {
    const onOpenPath = vi.fn();
    const preventDefault = vi.fn();
    const element = ProjectOpenPanel({
      path: '/Users/me/Project A',
      opening: false,
      canChooseDirectory: false,
      onPathChange: () => undefined,
      onOpenPath,
      onChooseDirectory: () => undefined
    });

    (element.props as { onSubmit(event: { preventDefault(): void }): void }).onSubmit({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenPath).toHaveBeenCalledWith('/Users/me/Project A');
  });

  it('renders validation errors and disables duplicate opens while loading', () => {
    const html = renderToStaticMarkup(
      <ProjectOpenPanel
        path="relative/project"
        error="Project path must be absolute."
        opening={true}
        canChooseDirectory={true}
        onPathChange={() => undefined}
        onOpenPath={() => undefined}
        onChooseDirectory={() => undefined}
      />
    );

    expect(html).toContain('Project path must be absolute.');
    expect(html).toContain('Open Path');
    expect(html).toContain('Choose Folder');
    expect(html).toContain('disabled=""');
  });
});
