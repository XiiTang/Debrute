import React from 'react';
import { FolderOpen } from 'lucide-react';
import { Button } from '../ui';

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
      className="project-open-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenProject();
      }}
    >
      <FolderOpen size={34} aria-hidden="true" />
      <strong>No project open</strong>
      {attemptedPath ? <span className="project-open-panel__path">{attemptedPath}</span> : null}
      {error ? <span className="project-open-panel__error">{error}</span> : null}
      <div className="project-open-panel__actions">
        <Button type="submit" variant="primary" iconStart={<FolderOpen size={15} />} loading={opening} disabled={opening}>
          Open Project
        </Button>
      </div>
    </form>
  );
}
