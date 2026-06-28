import React from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, EmptyState, Toolbar } from '../ui';
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
  return (
    <form
      className="project-open-panel db-project-open"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenProject();
      }}
    >
      <EmptyState
        title={i18n.t('projectOpen.title')}
        description={attemptedPath ? <span className="db-project-open__meta">{attemptedPath}</span> : undefined}
        action={(
          <Toolbar ariaLabel={i18n.t('projectOpen.actions')} className="db-action-row">
            <Button type="submit" variant="primary" iconStart={<FolderOpen size={15} />} loading={opening} disabled={opening}>
              {i18n.t('projectOpen.openProject')}
            </Button>
          </Toolbar>
        )}
      />
      {error ? <span className="db-form-error">{error}</span> : null}
    </form>
  );
}
