import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { ProjectOpenPanel } from './ProjectOpenPanel';

describe('ProjectOpenPanel', () => {
  it('renders the daemon picker open form action', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          opening={false}
          onOpenProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('<form');
    expect(html).toContain('Open Project');
    expect(html).toContain('type="submit"');
  });

  it('renders errors and attempted path context without a path input', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          error="Open project failed: projectRoot must resolve to a directory."
          attemptedPath="/missing/project"
          opening={true}
          onOpenProject={() => undefined}
        />
      </I18nProvider>
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
