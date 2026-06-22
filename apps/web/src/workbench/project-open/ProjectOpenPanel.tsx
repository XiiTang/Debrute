import React from 'react';
import { FolderOpen, FolderTree } from 'lucide-react';
import { Button, Field, Input } from '../ui';

export interface ProjectOpenPanelProps {
  path: string;
  error?: string | undefined;
  opening: boolean;
  canChooseDirectory: boolean;
  onPathChange(path: string): void;
  onOpenPath(path: string): void;
  onChooseDirectory(): void;
}

export function ProjectOpenPanel({
  path,
  error,
  opening,
  canChooseDirectory,
  onPathChange,
  onOpenPath,
  onChooseDirectory
}: ProjectOpenPanelProps): React.ReactElement {
  return (
    <form
      className="project-open-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onOpenPath(path);
      }}
    >
      <FolderOpen size={34} aria-hidden="true" />
      <strong>No project open</strong>
      <Field label="Project path" error={error}>
        <Input
          value={path}
          autoComplete="off"
          spellCheck={false}
          disabled={opening}
          onChange={(event) => onPathChange(event.currentTarget.value)}
        />
      </Field>
      <div className="project-open-panel__actions">
        <Button type="submit" variant="primary" iconStart={<FolderTree size={15} />} loading={opening}>
          Open Path
        </Button>
        {canChooseDirectory ? (
          <Button
            type="button"
            iconStart={<FolderOpen size={15} />}
            disabled={opening}
            onClick={onChooseDirectory}
          >
            Choose Folder
          </Button>
        ) : null}
      </div>
    </form>
  );
}
