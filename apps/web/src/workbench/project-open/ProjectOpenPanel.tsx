import React, { useLayoutEffect, useRef, useState } from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import { Button, EmptyState, Folder, FolderOpen, Loader2, Toolbar } from '../ui/index';
import { useI18n } from '../i18n';
import { recentProjectPresentation } from './recentProjectPresentation';

const RECENT_PROJECT_LIMIT = 5;

export interface ProjectOpenPanelProps {
  attemptedPath?: string | undefined;
  error?: string | undefined;
  opening: boolean;
  platform: DebruteProductPlatform;
  recentProjectRoots: readonly string[];
  userHome: string;
  onOpenProject(): void;
  onOpenRecentProject(projectRoot: string): void;
}

export function ProjectOpenPanel({
  attemptedPath,
  error,
  opening,
  platform,
  recentProjectRoots,
  userHome,
  onOpenProject,
  onOpenRecentProject
}: ProjectOpenPanelProps): React.ReactElement {
  const i18n = useI18n();
  const recentProjects = recentProjectRoots
    .slice(0, RECENT_PROJECT_LIMIT)
    .map((projectRoot) => recentProjectPresentation({ platform, projectRoot, userHome }));
  if (opening) {
    return (
      <div className="project-open-panel" role="status" aria-live="polite">
        <Loader2 className="spin" size={22} />
        <span>{i18n.t('shell.boot.openingProject')}</span>
      </div>
    );
  }
  return (
    <form
      className="project-open-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenProject();
      }}
    >
      <EmptyState
        title={i18n.t('projectOpen.title')}
        description={attemptedPath ? <span className="project-open-panel__meta">{attemptedPath}</span> : undefined}
        action={(
          <Toolbar ariaLabel={i18n.t('projectOpen.actions')} className="db-action-row">
            <Button type="submit" variant="primary" iconStart={<FolderOpen size={15} />}>
              {i18n.t('projectOpen.openProject')}
            </Button>
          </Toolbar>
        )}
      />
      {error ? <span className="project-open-panel__error" role="alert">{error}</span> : null}
      <section className="project-open-panel__recent" aria-labelledby="project-open-recent-title">
        <div className="project-open-panel__recent-heading">
          <h2 id="project-open-recent-title">{i18n.t('projectOpen.recent')}</h2>
          <span aria-hidden="true" />
        </div>
        {recentProjects.length > 0 ? (
          <ul className="project-open-panel__recent-list">
            {recentProjects.map(({ projectRoot, name, parentPath, compactParentPath }) => (
              <li key={projectRoot}>
                <button
                  type="button"
                  className="project-open-panel__recent-project"
                  aria-label={i18n.t('projectOpen.openRecentProject', {
                    name,
                    path: projectRoot
                  })}
                  title={projectRoot}
                  onClick={() => onOpenRecentProject(projectRoot)}
                >
                  <Folder size={16} />
                  <span className="project-open-panel__recent-project-text">
                    <strong>{name}</strong>
                    {parentPath ? (
                      <ResponsiveRecentProjectPath
                        compactParentPath={compactParentPath}
                        parentPath={parentPath}
                      />
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="project-open-panel__recent-empty">
            {i18n.t('projectOpen.noRecentProjects')}
          </p>
        )}
      </section>
    </form>
  );
}

function ResponsiveRecentProjectPath({
  compactParentPath,
  parentPath
}: {
  compactParentPath: string;
  parentPath: string;
}): React.ReactElement {
  const containerRef = useRef<HTMLSpanElement>(null);
  const fullMeasurementRef = useRef<HTMLSpanElement>(null);
  const compactMeasurementRef = useRef<HTMLSpanElement>(null);
  const [density, setDensity] = useState<'full' | 'compact' | 'hidden'>('full');

  useLayoutEffect(() => {
    const container = containerRef.current;
    const fullMeasurement = fullMeasurementRef.current;
    const compactMeasurement = compactMeasurementRef.current;
    if (!container || !fullMeasurement || !compactMeasurement) {
      return;
    }
    const update = (): void => {
      const availableWidth = container.clientWidth;
      const fullWidth = fullMeasurement.getBoundingClientRect().width;
      const compactWidth = compactMeasurement.getBoundingClientRect().width;
      setDensity(
        availableWidth >= fullWidth
          ? 'full'
          : availableWidth >= compactWidth
            ? 'compact'
            : 'hidden'
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(fullMeasurement);
    observer.observe(compactMeasurement);
    return () => observer.disconnect();
  }, [compactParentPath, parentPath]);

  return (
    <span ref={containerRef} className="project-open-panel__recent-project-path">
      <span className="project-open-panel__recent-project-path-value">
        {density === 'full' ? parentPath : density === 'compact' ? compactParentPath : null}
      </span>
      <span
        ref={fullMeasurementRef}
        aria-hidden="true"
        className="project-open-panel__recent-project-path-measure"
      >
        {parentPath}
      </span>
      <span
        ref={compactMeasurementRef}
        aria-hidden="true"
        className="project-open-panel__recent-project-path-measure"
      >
        {compactParentPath}
      </span>
    </span>
  );
}
