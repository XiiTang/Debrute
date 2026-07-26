import { useLayoutEffect } from 'react';
import '../styles/explorer.css';
import type { DebruteProductPlatform, WorkbenchLocale } from '@debrute/app-protocol';
import type { WorkbenchState } from '../../types.js';
import { I18nProvider } from '../i18n/index.js';
import type {
  WorkbenchContextMenuPosition,
  WorkbenchContextMenuTarget,
  WorkbenchFileClipboard
} from '../shell/contextMenu.js';
import { ProjectTree } from './ProjectTree.js';
import type { ProjectTreeInlineEditState } from './projectTreeEditing.js';
import type { ProjectTreeFileKeyboardCommand } from './projectTreeKeyboardCommands.js';
import {
  useProjectExplorerController,
  type ProjectExplorerController,
  type ProjectExplorerControllerInput
} from './useProjectExplorerController.js';

export function WorkbenchExplorerControllerHost({
  onController,
  ...input
}: ProjectExplorerControllerInput & {
  onController(controller: ProjectExplorerController): void;
}): null {
  const controller = useProjectExplorerController(input);
  useLayoutEffect(() => {
    onController(controller);
  }, [controller, onController]);
  return null;
}

export function WorkbenchExplorerPanelFeature({
  locale,
  state,
  fileClipboard,
  inlineProjectTreeEdit,
  onExplorerSelectionChange,
  onLocateFileInCanvas,
  onProjectTreeInternalDrop,
  onProjectTreeExternalDrop,
  onOpenContextMenu,
  onCreateRootFile,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onClearCut,
  onExpandProjectDirectory,
  productPlatform,
  onKeyboardFileCommand
}: {
  locale: WorkbenchLocale;
  state: WorkbenchState;
  fileClipboard?: WorkbenchFileClipboard | undefined;
  inlineProjectTreeEdit?: ProjectTreeInlineEditState | undefined;
  onExplorerSelectionChange(selection: WorkbenchState['explorerSelection']): void;
  onLocateFileInCanvas?: ((projectRelativePath: string) => void) | undefined;
  onProjectTreeInternalDrop?: ((input: {
    entries: Array<{ projectRelativePath: string; kind: 'file' | 'directory' }>;
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => void) | undefined;
  onProjectTreeExternalDrop?: ((input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  onCreateRootFile?: (() => void) | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  onExpandProjectDirectory?: ((projectRelativeDirectory: string) => void) | undefined;
  productPlatform: DebruteProductPlatform;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
}): React.ReactElement {
  return (
    <I18nProvider locale={locale}>
      <ProjectTree
        snapshot={state.snapshot}
        selection={state.explorerSelection}
        cutPaths={fileClipboard?.operation === 'cut'
          ? fileClipboard.entries.map((entry) => entry.projectRelativePath)
          : []}
        editing={inlineProjectTreeEdit}
        onSelectionChange={onExplorerSelectionChange}
        onLocateFileInCanvas={onLocateFileInCanvas}
        onInternalDrop={onProjectTreeInternalDrop}
        onExternalDrop={onProjectTreeExternalDrop}
        onOpenContextMenu={onOpenContextMenu}
        onCreateRootFile={onCreateRootFile}
        onEditValueChange={onEditValueChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
        onClearCut={onClearCut}
        onExpandDirectory={onExpandProjectDirectory}
        productPlatform={productPlatform}
        onKeyboardFileCommand={onKeyboardFileCommand}
      />
    </I18nProvider>
  );
}
