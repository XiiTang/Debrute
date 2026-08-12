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
          platform="darwin"
          recentProjectRoots={[]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
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
          opening={false}
          platform="darwin"
          recentProjectRoots={[]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
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
    expect(html).not.toContain('<input');
  });

  it('replaces the open action with a direct Canvas loading state', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          opening
          platform="darwin"
          recentProjectRoots={[]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('Opening project');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
  });

  it('reports an open failure', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          attemptedPath="/damaged/project"
          error="Project root could not be opened"
          opening={false}
          platform="darwin"
          recentProjectRoots={[]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Project root could not be opened');
  });

  it('renders up to five recent Projects with their folder name and parent path', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          opening={false}
          platform="darwin"
          recentProjectRoots={[
            '/Users/cq/Projects/Alpha',
            'C:\\Beta',
            '/projects/gamma',
            '/projects/delta',
            '/projects/epsilon',
            '/projects/not-rendered'
          ]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Recent');
    expect(html).toContain('Alpha');
    expect(html).toContain('~/Projects');
    expect(html).toContain('aria-label="Open recent Project Alpha at /Users/cq/Projects/Alpha"');
    expect(html).toContain('Beta');
    expect(html).toContain('C:\\');
    expect(html).toContain('epsilon');
    expect(html).not.toContain('not-rendered');
    expect(html.match(/project-open-panel__recent-project"/g) ?? []).toHaveLength(5);
    expect(html).toContain('type="button"');
  });

  it('keeps an explicit Recent section when no recent Project exists', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          opening={false}
          platform="darwin"
          recentProjectRoots={[]}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('Recent');
    expect(html).toContain('No Recent Projects');
  });

  it('renders filesystem roots without repeating them as parent paths', () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en">
        <ProjectOpenPanel
          opening={false}
          platform="darwin"
          recentProjectRoots={['/', 'C:\\']}
          userHome="/Users/cq"
          onOpenProject={() => undefined}
          onOpenRecentProject={() => undefined}
        />
      </I18nProvider>
    );

    expect(html).toContain('project-open-panel__recent-project-text"><strong>/</strong></span>');
    expect(html).toContain('project-open-panel__recent-project-text"><strong>C:\\</strong></span>');
  });
});
