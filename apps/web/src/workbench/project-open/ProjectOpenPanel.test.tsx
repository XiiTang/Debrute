import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n';
import { ProjectOpenPanel } from './ProjectOpenPanel';

describe('ProjectOpenPanel', () => {
  it('renders the Runtime picker open form action', () => {
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
          error="Could not open project"
          attemptedPath="/missing/project"
          opening={true}
          onOpenProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not open project');
    expect(html).toContain('/missing/project');
    expect(html).toContain('Open Project');
    expect(html).toContain('project-open-panel');
    expect(html).toContain('project-open-panel__meta');
    expect(html).toContain('project-open-panel__error');
    expect(html).toContain('db-empty-state');
    expect(html).toContain('db-action-row');
    expect(html).toContain('db-button--primary');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('<input');
  });
});
