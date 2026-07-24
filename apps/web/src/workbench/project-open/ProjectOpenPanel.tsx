import React from 'react';
import { Button, EmptyState, FolderOpen, Loader2, Toolbar } from '../ui/index.js';
import { useI18n } from '../i18n';

export interface ProjectOpenPanelProps {
  attemptedPath?: string | undefined;
  error?: string | undefined;
  opening: boolean;
  onOpenProject(): void;
}

export function ProjectOpenPanel({
  attemptedPath,
  error,
  opening,
  onOpenProject
}: ProjectOpenPanelProps): React.ReactElement {
  const i18n = useI18n();
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
    </form>
  );
}
