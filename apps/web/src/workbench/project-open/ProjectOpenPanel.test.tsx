import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProjectOpenPanel } from './ProjectOpenPanel';

describe('ProjectOpenPanel', () => {
  it('submits the daemon picker open action', () => {
    const onOpenProject = vi.fn();
    const preventDefault = vi.fn();
    const element = ProjectOpenPanel({
      opening: false,
      onOpenProject
    });

    (element.props as { onSubmit(event: { preventDefault(): void }): void }).onSubmit({ preventDefault });

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onOpenProject).toHaveBeenCalledOnce();
  });

  it('renders errors and attempted path context without a path input', () => {
    const html = renderToStaticMarkup(
      <ProjectOpenPanel
        error="Open project failed: projectRoot must resolve to a directory."
        attemptedPath="/missing/project"
        opening={true}
        onOpenProject={() => undefined}
      />
    );

    expect(html).toContain('Open project failed: projectRoot must resolve to a directory.');
    expect(html).toContain('/missing/project');
    expect(html).toContain('Open Project');
    expect(html).toContain('db-project-open');
    expect(html).toContain('db-empty-state');
    expect(html).toContain('db-action-row');
    expect(html).toContain('db-button--primary');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<input');
  });
});
