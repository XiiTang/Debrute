import React from 'react';
import { FolderOpen } from 'lucide-react';
import { Button, EmptyState, Toolbar } from '../ui';

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
  return (
    <form
      className="project-open-panel db-project-open"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenProject();
      }}
    >
      <EmptyState
        title="No project open"
        description={attemptedPath ? <span className="db-project-open__meta">{attemptedPath}</span> : undefined}
        action={(
          <Toolbar ariaLabel="Project open actions" className="db-action-row">
            <Button type="submit" variant="primary" iconStart={<FolderOpen size={15} />} loading={opening} disabled={opening}>
              Open Project
            </Button>
          </Toolbar>
        )}
      />
      {error ? <span className="db-form-error">{error}</span> : null}
    </form>
  );
}
