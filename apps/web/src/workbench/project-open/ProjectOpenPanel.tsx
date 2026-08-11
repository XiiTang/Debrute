import React from 'react';
import { Button, EmptyState, Folder, FolderOpen, Loader2, Toolbar } from '../ui/index.js';
import { useI18n } from '../i18n';

const RECENT_PROJECT_LIMIT = 5;

export interface ProjectOpenPanelProps {
  attemptedPath?: string | undefined;
  error?: string | undefined;
  opening: boolean;
  recentProjectRoots: readonly string[];
  onOpenProject(): void;
  onOpenRecentProject(projectRoot: string): void;
}

export function ProjectOpenPanel({
  attemptedPath,
  error,
  opening,
  recentProjectRoots,
  onOpenProject,
  onOpenRecentProject
}: ProjectOpenPanelProps): React.ReactElement {
  const i18n = useI18n();
  const recentProjects = recentProjectRoots
    .slice(0, RECENT_PROJECT_LIMIT)
    .map(projectRootPresentation);
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
            {recentProjects.map(({ projectRoot, name, parentPath }) => (
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
                    {parentPath ? <span>{parentPath}</span> : null}
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

interface ProjectRootPresentation {
  projectRoot: string;
  name: string;
  parentPath: string;
}

function projectRootPresentation(projectRoot: string): ProjectRootPresentation {
  if (projectRoot === '/' || /^[A-Za-z]:[\\/]$/.test(projectRoot)) {
    return { projectRoot, name: projectRoot, parentPath: '' };
  }
  const withoutTrailingSeparators = projectRoot.replace(/[\\/]+$/, '');
  const displayRoot = withoutTrailingSeparators || projectRoot;
  const separatorIndex = Math.max(
    displayRoot.lastIndexOf('/'),
    displayRoot.lastIndexOf('\\')
  );
  const name = displayRoot.slice(separatorIndex + 1) || displayRoot;
  let parentPath = separatorIndex < 0 ? '' : displayRoot.slice(0, separatorIndex);
  if (
    separatorIndex === 0
    || (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(displayRoot))
  ) {
    parentPath = displayRoot.slice(0, separatorIndex + 1);
  }
  return { projectRoot, name, parentPath };
}
