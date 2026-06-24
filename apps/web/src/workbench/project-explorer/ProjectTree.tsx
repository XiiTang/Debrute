import React, { useEffect, useMemo, useState } from 'react';
import { File, FilePlus2, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type {
  WorkbenchContextMenuPosition,
  WorkbenchContextMenuTarget,
  WorkbenchExplorerContextMenuTarget,
  WorkbenchProjectPathEntry
} from '../shell/contextMenu';
import { EmptyState, Input, cx } from '../ui';
import { buildProjectFileTree, expandedProjectTreePaths, type ProjectFileTreeNode } from './projectFileTree';
import type { ProjectTreeInlineEditState } from './projectTreeEditing';
import {
  projectTreeKeyboardCommandFromEvent,
  type ProjectTreeFileKeyboardCommand,
  type ProjectTreeKeyboardEventLike
} from './projectTreeKeyboardCommands';
import {
  clearProjectTreeSelection,
  flattenProjectTree,
  normalizeProjectTreeSelection,
  isProjectTreeDropRejected,
  isProjectTreeMoveNoop,
  projectTreeParentPath,
  projectTreeDragEntries,
  projectTreeDropOperation,
  projectTreeDropTargetDirectory,
  projectTreePathEntriesFromSelection,
  updateProjectTreeContextSelection,
  updateProjectTreeSelection,
  type ProjectTreePointerModifiers,
  type ProjectTreeSelectionState,
  type ProjectTreeVisibleItem
} from './projectTreeInteraction';
import { hasProjectTreeExternalDrag } from './projectTreeExternalDrop';

export const PROJECT_TREE_DRAG_MIME = 'application/x-debrute-project-tree-paths';

export function ProjectTree({
  snapshot,
  selection,
  cutPaths,
  editing,
  onSelectionChange,
  onLocateFileInCanvas,
  onInternalDrop,
  onExternalDrop,
  onOpenContextMenu,
  onCreateRootFile,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onClearCut,
  desktopPlatform,
  onKeyboardFileCommand
}: {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  selection: ProjectTreeSelectionState;
  cutPaths: string[];
  editing?: ProjectTreeInlineEditState | undefined;
  onSelectionChange: (selection: ProjectTreeSelectionState) => void;
  onLocateFileInCanvas?: ((projectRelativePath: string) => void) | undefined;
  onInternalDrop?: ((input: {
    entries: WorkbenchProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => void) | undefined;
  onExternalDrop?: ((input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => void) | undefined;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  onCreateRootFile?: (() => void) | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  desktopPlatform?: NodeJS.Platform | undefined;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
}): React.ReactElement {
  const tree = useMemo(() => buildProjectFileTree(snapshot?.files ?? []), [snapshot?.files]);
  const defaultExpanded = useMemo(() => expandedProjectTreePaths(tree, selection.selectedPaths), [selection.selectedPaths, tree]);
  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const visibleItems = useMemo(() => flattenProjectTree(tree, expanded), [expanded, tree]);
  const normalizedSelection = useMemo(() => normalizeProjectTreeSelection(selection, visibleItems), [selection, visibleItems]);
  const cutPathSet = useMemo(() => new Set(cutPaths), [cutPaths]);
  const rootCreateEditing = editing && isCreatingInlineEditState(editing) && editing.parentProjectRelativePath === ''
    ? editing
    : undefined;

  useEffect(() => {
    setExpanded((current) => new Set([...current, ...defaultExpanded]));
  }, [defaultExpanded]);

  useEffect(() => {
    if (editing && isCreatingInlineEditState(editing) && editing.parentProjectRelativePath) {
      setExpanded((current) => new Set([...current, editing.parentProjectRelativePath]));
    }
  }, [editing]);

  return (
    <div className="project-tree-shell">
      <div
        className="project-tree"
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        onClick={(event) => {
          if (!isRootBlankAreaEventTarget(event)) {
            return;
          }
          onSelectionChange(clearProjectTreeSelection());
        }}
        onDoubleClick={(event) => {
          if (isRootBlankAreaEventTarget(event)) {
            onCreateRootFile?.();
          }
        }}
        onContextMenu={(event) => {
          handleProjectTreeRootContextMenuEvent({
            event,
            onSelectionChange,
            onOpenContextMenu
          });
        }}
        onDragOver={(event) => {
          if (!isRootBlankAreaEventTarget(event)) {
            return;
          }
          const targetDirectoryProjectRelativePath = '';
          if (!hasInternalProjectTreeDrag(event.dataTransfer) && !hasProjectTreeExternalDrag(event.dataTransfer)) {
            return;
          }
          if (hasInternalProjectTreeDrag(event.dataTransfer)) {
            const entries = readInternalProjectTreeDragEntries(event.dataTransfer);
            if (!isAcceptedInternalProjectTreeDrop({
              entries,
              targetDirectoryProjectRelativePath,
              operation: projectTreeDropOperation({ platform: desktopPlatform ?? 'linux', event })
            })) {
              return;
            }
          }
          event.preventDefault();
          setDragOverPath('');
        }}
        onDragLeave={(event) => {
          if (isRootBlankAreaEventTarget(event)) {
            setDragOverPath(null);
          }
        }}
        onDrop={(event) => {
          if (!isRootBlankAreaEventTarget(event)) {
            return;
          }
          const targetDirectoryProjectRelativePath = '';
          event.preventDefault();
          setDragOverPath(null);
          if (!hasInternalProjectTreeDrag(event.dataTransfer)) {
            if (hasProjectTreeExternalDrag(event.dataTransfer)) {
              onExternalDrop?.({
                dataTransfer: event.dataTransfer,
                targetDirectoryProjectRelativePath
              });
            }
            return;
          }
          const entries = readInternalProjectTreeDragEntries(event.dataTransfer);
          const operation = projectTreeDropOperation({ platform: desktopPlatform ?? 'linux', event });
          if (entries.length > 0 && isAcceptedInternalProjectTreeDrop({
            entries,
            targetDirectoryProjectRelativePath,
            operation
          })) {
            onInternalDrop?.({
              entries,
              targetDirectoryProjectRelativePath,
              operation
            });
          }
        }}
        onKeyDown={(event) => handleProjectTreeKeyboardEvent({
          event,
          editing,
          selection: normalizedSelection,
          visibleItems,
          expanded,
          desktopPlatform: desktopPlatform ?? 'linux',
          onEditCancel,
          onClearCut,
          onSelectionChange,
          onExpandedChange: setExpanded,
          onKeyboardFileCommand
        })}
      >
        {rootCreateEditing ? (
          <ProjectTreeInlineEditRow
            depth={0}
            editing={rootCreateEditing}
            onEditValueChange={onEditValueChange}
            onEditSubmit={onEditSubmit}
            onEditCancel={onEditCancel}
          />
        ) : null}
        {tree.length === 0 ? <EmptyState className="empty-line" data-project-tree-empty-line title="No project files" /> : null}
        {tree.map((node) => (
          <ProjectTreeRow
            key={node.path}
            node={node}
            depth={0}
            selection={normalizedSelection}
            cutPaths={cutPathSet}
            visibleItems={visibleItems}
            editing={editing}
            expanded={expanded}
            desktopPlatform={desktopPlatform ?? 'linux'}
            dragOverPath={dragOverPath}
            onToggle={(path) => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(path)) {
                next.delete(path);
              } else {
                next.add(path);
              }
              return next;
            })}
            onSelectionChange={onSelectionChange}
            onLocateFileInCanvas={onLocateFileInCanvas}
            onInternalDrop={onInternalDrop}
            onExternalDrop={onExternalDrop}
            setDragOverPath={setDragOverPath}
            onOpenContextMenu={onOpenContextMenu}
            onEditValueChange={onEditValueChange}
            onEditSubmit={onEditSubmit}
            onEditCancel={onEditCancel}
          />
        ))}
      </div>
    </div>
  );
}

export function handleProjectTreeKeyboardEvent(input: {
  event: ProjectTreeKeyboardEventLike & {
    preventDefault(): void;
    stopPropagation(): void;
  };
  editing: ProjectTreeInlineEditState | undefined;
  selection: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
  expanded?: Set<string> | undefined;
  desktopPlatform: NodeJS.Platform;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  onSelectionChange?: ((selection: ProjectTreeSelectionState) => void) | undefined;
  onExpandedChange?: ((expanded: Set<string>) => void) | undefined;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
}): void {
  if (input.event.key === 'Escape' && input.editing) {
    input.onEditCancel?.();
    return;
  }
  if (!input.editing) {
    const navigation = projectTreeKeyboardNavigation({
      key: input.event.key,
      selection: input.selection,
      visibleItems: input.visibleItems,
      expanded: input.expanded ?? new Set()
    });
    if (navigation) {
      input.event.preventDefault();
      input.event.stopPropagation();
      if (navigation.selection) {
        input.onSelectionChange?.(navigation.selection);
      }
      if (navigation.expanded) {
        input.onExpandedChange?.(navigation.expanded);
      }
      return;
    }
  }
  const command = projectTreeKeyboardCommandFromEvent(input.event, input.desktopPlatform);
  if (!command) {
    return;
  }
  if (command === 'cancel-cut') {
    input.event.preventDefault();
    input.event.stopPropagation();
    input.onClearCut?.();
    return;
  }
  const target = explorerTargetFromSelection(input.selection, input.visibleItems);
  if (target.targetKind === 'root' && command !== 'paste') {
    return;
  }
  input.event.preventDefault();
  input.event.stopPropagation();
  input.onKeyboardFileCommand?.(command, target);
}

export function projectTreeRowClickAction(input: {
  kind: ProjectFileTreeNode['kind'];
  platform: NodeJS.Platform;
  event: ProjectTreePointerModifiers;
}): { toggleDirectory: boolean; locateFileInCanvas: boolean } {
  const selectionModifier = isSelectionModifierEvent(input.event, input.platform);
  return {
    toggleDirectory: input.kind === 'directory' && !selectionModifier,
    locateFileInCanvas: input.kind === 'file' && !selectionModifier
  };
}

export function isRootBlankAreaEventTarget(input: { target: unknown; currentTarget: unknown }): boolean {
  if (input.target === input.currentTarget) {
    return true;
  }
  if (typeof input.target !== 'object' || input.target === null) {
    return false;
  }
  const closest = (input.target as { closest?: unknown }).closest;
  return typeof closest === 'function' && Boolean(closest.call(input.target, '[data-project-tree-empty-line]'));
}

export function handleProjectTreeRootContextMenuEvent(input: {
  event: {
    target: unknown;
    currentTarget: unknown;
    clientX: number;
    clientY: number;
    preventDefault(): void;
  };
  onSelectionChange: (selection: ProjectTreeSelectionState) => void;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
}): boolean {
  if (!isRootBlankAreaEventTarget(input.event)) {
    return false;
  }
  input.event.preventDefault();
  input.onSelectionChange(clearProjectTreeSelection());
  input.onOpenContextMenu?.(rootExplorerTarget(), {
    x: input.event.clientX,
    y: input.event.clientY
  });
  return true;
}

function projectTreeKeyboardNavigation(input: {
  key: string;
  selection: ProjectTreeSelectionState;
  visibleItems: ProjectTreeVisibleItem[];
  expanded: Set<string>;
}): { selection?: ProjectTreeSelectionState; expanded?: Set<string> } | undefined {
  if (input.visibleItems.length === 0) {
    return undefined;
  }
  const focusedIndex = input.selection.focusedPath
    ? input.visibleItems.findIndex((item) => item.path === input.selection.focusedPath)
    : -1;
  if (input.key === 'ArrowDown') {
    const nextIndex = focusedIndex < 0 ? 0 : Math.min(input.visibleItems.length - 1, focusedIndex + 1);
    return nextIndex === focusedIndex ? undefined : { selection: projectTreeSelectionForPath(input.visibleItems[nextIndex]!.path) };
  }
  if (input.key === 'ArrowUp') {
    const nextIndex = focusedIndex < 0 ? input.visibleItems.length - 1 : Math.max(0, focusedIndex - 1);
    return nextIndex === focusedIndex ? undefined : { selection: projectTreeSelectionForPath(input.visibleItems[nextIndex]!.path) };
  }
  if (focusedIndex < 0) {
    return undefined;
  }
  const focusedItem = input.visibleItems[focusedIndex]!;
  if (input.key === 'ArrowRight' && focusedItem.kind === 'directory') {
    if (!input.expanded.has(focusedItem.path)) {
      return { expanded: new Set([...input.expanded, focusedItem.path]) };
    }
    const child = input.visibleItems[focusedIndex + 1];
    if (child && child.depth > focusedItem.depth) {
      return { selection: projectTreeSelectionForPath(child.path) };
    }
  }
  if (input.key === 'ArrowLeft') {
    if (focusedItem.kind === 'directory' && input.expanded.has(focusedItem.path)) {
      const nextExpanded = new Set(input.expanded);
      nextExpanded.delete(focusedItem.path);
      return { expanded: nextExpanded };
    }
    if (focusedItem.parentPath) {
      const parent = input.visibleItems.find((item) => item.path === focusedItem.parentPath);
      return parent ? { selection: projectTreeSelectionForPath(parent.path) } : undefined;
    }
  }
  return undefined;
}

function projectTreeSelectionForPath(projectRelativePath: string): ProjectTreeSelectionState {
  return {
    selectedPaths: [projectRelativePath],
    focusedPath: projectRelativePath,
    anchorPath: projectRelativePath
  };
}

function ProjectTreeRow({
  node,
  depth,
  selection,
  cutPaths,
  visibleItems,
  editing,
  expanded,
  desktopPlatform,
  dragOverPath,
  onToggle,
  onSelectionChange,
  onLocateFileInCanvas,
  onInternalDrop,
  onExternalDrop,
  setDragOverPath,
  onOpenContextMenu,
  onEditValueChange,
  onEditSubmit,
  onEditCancel
}: {
  node: ProjectFileTreeNode;
  depth: number;
  selection: ProjectTreeSelectionState;
  cutPaths: Set<string>;
  visibleItems: ProjectTreeVisibleItem[];
  editing: ProjectTreeInlineEditState | undefined;
  expanded: Set<string>;
  desktopPlatform: NodeJS.Platform;
  dragOverPath: string | null;
  onToggle: (path: string) => void;
  onSelectionChange: (selection: ProjectTreeSelectionState) => void;
  onLocateFileInCanvas?: ((projectRelativePath: string) => void) | undefined;
  onInternalDrop?: ((input: {
    entries: WorkbenchProjectPathEntry[];
    targetDirectoryProjectRelativePath: string;
    operation: 'copy' | 'move';
  }) => void) | undefined;
  onExternalDrop?: ((input: {
    dataTransfer: DataTransfer;
    targetDirectoryProjectRelativePath: string;
  }) => void) | undefined;
  setDragOverPath: (path: string | null) => void;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
}): React.ReactElement {
  const selected = selection.selectedPaths.includes(node.path);
  const focused = selection.focusedPath === node.path;
  const style = { '--tree-indent': `${depth * 14}px` } as React.CSSProperties;
  const rowClassName = cx(
    'project-tree-row',
    selected && 'selected',
    focused && 'focused',
    dragOverPath === node.path && 'drag-over',
    cutPaths.has(node.path) && 'cut',
    'db-tree-row'
  )!;
  const renameEditing = editing?.kind === 'renaming' && editing.projectRelativePath === node.path ? editing : undefined;
  const createEditing = editing && isCreatingInlineEditState(editing) && editing.parentProjectRelativePath === node.path
    ? editing
    : undefined;
  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const nextSelection = updateProjectTreeContextSelection({
      state: selection,
      visibleItems,
      path: node.path
    });
    onSelectionChange(nextSelection);
    onOpenContextMenu?.(explorerTargetFromSelection(nextSelection, visibleItems), {
      x: event.clientX,
      y: event.clientY
    });
  };
  const selectRow = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const action = projectTreeRowClickAction({
      kind: node.kind,
      platform: desktopPlatform,
      event
    });
    const nextSelection = updateProjectTreeSelection({
      state: selection,
      visibleItems,
      path: node.path,
      platform: desktopPlatform,
      event
    });
    onSelectionChange(nextSelection);
    if (action.toggleDirectory) {
      onToggle(node.path);
    }
    if (action.locateFileInCanvas) {
      onLocateFileInCanvas?.(node.path);
    }
  };
  const dragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const entries = projectTreeDragEntries({
      selection,
      visibleItems,
      path: node.path
    });
    if (entries.length === 0) {
      event.preventDefault();
      return;
    }
    if (!selection.selectedPaths.includes(node.path)) {
      onSelectionChange(updateProjectTreeSelection({
        state: selection,
        visibleItems,
        path: node.path,
        platform: desktopPlatform,
        event: {}
      }));
    }
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData(PROJECT_TREE_DRAG_MIME, JSON.stringify(entries));
  };
  const dragOver = (event: React.DragEvent<HTMLButtonElement>) => {
    if (!hasInternalProjectTreeDrag(event.dataTransfer) && !hasProjectTreeExternalDrag(event.dataTransfer)) {
      return;
    }
    const targetDirectoryProjectRelativePath = projectTreeDropTargetDirectory({
      visibleItems,
      path: node.path
    });
    if (hasInternalProjectTreeDrag(event.dataTransfer)) {
      const entries = readInternalProjectTreeDragEntries(event.dataTransfer);
      if (!isAcceptedInternalProjectTreeDrop({
        entries,
        targetDirectoryProjectRelativePath,
        operation: projectTreeDropOperation({ platform: desktopPlatform, event })
      })) {
        return;
      }
    }
    event.preventDefault();
    event.stopPropagation();
    setDragOverPath(node.path);
  };
  const drop = (event: React.DragEvent<HTMLButtonElement>) => {
    if (!hasInternalProjectTreeDrag(event.dataTransfer) && !hasProjectTreeExternalDrag(event.dataTransfer)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDragOverPath(null);
    const targetDirectoryProjectRelativePath = projectTreeDropTargetDirectory({
      visibleItems,
      path: node.path
    });
    if (!hasInternalProjectTreeDrag(event.dataTransfer)) {
      onExternalDrop?.({
        dataTransfer: event.dataTransfer,
        targetDirectoryProjectRelativePath
      });
      return;
    }
    const entries = readInternalProjectTreeDragEntries(event.dataTransfer);
    if (entries.length === 0) {
      return;
    }
    const operation = projectTreeDropOperation({ platform: desktopPlatform, event });
    if (!isAcceptedInternalProjectTreeDrop({
      entries,
      targetDirectoryProjectRelativePath,
      operation
    })) {
      return;
    }
    onInternalDrop?.({
      entries,
      targetDirectoryProjectRelativePath,
      operation
    });
  };

  if (node.kind === 'directory') {
    const open = expanded.has(node.path);
    return (
      <div role="treeitem" aria-expanded={open} aria-selected={selected}>
        {renameEditing ? (
          <ProjectTreeRenameRow
            node={node}
            depth={depth}
            open={open}
            rowClassName={rowClassName}
            editing={renameEditing}
            onEditValueChange={onEditValueChange}
            onEditSubmit={onEditSubmit}
            onEditCancel={onEditCancel}
          />
        ) : (
          <button
            type="button"
            className={rowClassName}
            style={style}
            title={node.path}
            data-project-tree-context-path={node.path}
            draggable
            onClick={selectRow}
            onContextMenu={openContextMenu}
            onDragStart={dragStart}
            onDragOver={dragOver}
            onDragLeave={() => setDragOverPath(null)}
            onDrop={drop}
          >
            {open ? <FolderOpen size={14} /> : <Folder size={14} />}
            <span>{node.name}</span>
          </button>
        )}
        {open ? (
          <div role="group">
            {createEditing ? (
              <ProjectTreeInlineEditRow
                depth={depth + 1}
                editing={createEditing}
                onEditValueChange={onEditValueChange}
                onEditSubmit={onEditSubmit}
                onEditCancel={onEditCancel}
              />
            ) : null}
            {node.children.map((child) => (
              <ProjectTreeRow
                key={child.path}
                node={child}
                depth={depth + 1}
                selection={selection}
                cutPaths={cutPaths}
                visibleItems={visibleItems}
                editing={editing}
                expanded={expanded}
                desktopPlatform={desktopPlatform}
                dragOverPath={dragOverPath}
                onToggle={onToggle}
                onSelectionChange={onSelectionChange}
                onLocateFileInCanvas={onLocateFileInCanvas}
                onInternalDrop={onInternalDrop}
                onExternalDrop={onExternalDrop}
                setDragOverPath={setDragOverPath}
                onOpenContextMenu={onOpenContextMenu}
                onEditValueChange={onEditValueChange}
                onEditSubmit={onEditSubmit}
                onEditCancel={onEditCancel}
              />
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (renameEditing) {
    return (
      <ProjectTreeRenameRow
        node={node}
        depth={depth}
        rowClassName={rowClassName}
        editing={renameEditing}
        onEditValueChange={onEditValueChange}
        onEditSubmit={onEditSubmit}
        onEditCancel={onEditCancel}
      />
    );
  }

  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      className={rowClassName}
      style={style}
      title={node.path}
      data-project-tree-context-path={node.path}
      draggable
      onClick={selectRow}
      onContextMenu={openContextMenu}
      onDragStart={dragStart}
      onDragOver={dragOver}
      onDragLeave={() => setDragOverPath(null)}
      onDrop={drop}
    >
      <File size={14} />
      <span>{node.name}</span>
    </button>
  );
}

export function hasInternalProjectTreeDrag(dataTransfer: Pick<DataTransfer, 'types'>): boolean {
  return Array.from(dataTransfer.types).includes(PROJECT_TREE_DRAG_MIME);
}

export function readInternalProjectTreeDragEntries(dataTransfer: Pick<DataTransfer, 'getData'>): WorkbenchProjectPathEntry[] {
  const raw = dataTransfer.getData(PROJECT_TREE_DRAG_MIME);
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as WorkbenchProjectPathEntry[];
  return parsed.filter((entry) => (
    typeof entry.projectRelativePath === 'string' && (entry.kind === 'file' || entry.kind === 'directory')
  ));
}

function isAcceptedInternalProjectTreeDrop(input: {
  entries: WorkbenchProjectPathEntry[];
  targetDirectoryProjectRelativePath: string;
  operation: 'copy' | 'move';
}): boolean {
  if (input.entries.length === 0 || isProjectTreeDropRejected({
    entries: input.entries,
    targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
  })) {
    return false;
  }
  return input.operation !== 'move' || !isProjectTreeMoveNoop({
    entries: input.entries,
    targetDirectoryProjectRelativePath: input.targetDirectoryProjectRelativePath
  });
}

function explorerTargetFromSelection(
  selection: ProjectTreeSelectionState,
  visibleItems: ProjectTreeVisibleItem[]
): WorkbenchExplorerContextMenuTarget {
  const entries = projectTreePathEntriesFromSelection({ selection, visibleItems });
  if (entries.length === 0) {
    return rootExplorerTarget();
  }
  if (entries.length === 1) {
    return itemExplorerTarget(entries[0]!);
  }
  return {
    source: 'explorer',
    targetKind: 'selection',
    paths: entries,
    primaryPath: entries[0]!.projectRelativePath,
    targetDirectoryPath: projectTreeDropTargetDirectory({
      visibleItems,
      path: selection.focusedPath ?? entries[0]!.projectRelativePath
    })
  };
}

function itemExplorerTarget(entry: WorkbenchProjectPathEntry): WorkbenchExplorerContextMenuTarget {
  return {
    source: 'explorer',
    targetKind: 'item',
    paths: [entry],
    primaryPath: entry.projectRelativePath,
    targetDirectoryPath: entry.kind === 'directory' ? entry.projectRelativePath : projectTreeParentPath(entry.projectRelativePath)
  };
}

function rootExplorerTarget(): WorkbenchExplorerContextMenuTarget {
  return {
    source: 'explorer',
    targetKind: 'root',
    paths: [],
    primaryPath: null,
    targetDirectoryPath: ''
  };
}

function isSelectionModifierEvent(event: ProjectTreePointerModifiers, platform: NodeJS.Platform): boolean {
  return event.shiftKey === true || (platform === 'darwin' ? event.metaKey === true : event.ctrlKey === true);
}

function ProjectTreeInlineEditRow({
  depth,
  editing,
  onEditValueChange,
  onEditSubmit,
  onEditCancel
}: {
  depth: number;
  editing: Extract<ProjectTreeInlineEditState, { kind: 'creating-file' | 'creating-directory' }>;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
}): React.ReactElement {
  const style = { '--tree-indent': `${depth * 14}px` } as React.CSSProperties;
  return (
    <div className="project-tree-edit-row" style={style} data-project-tree-edit-kind={editing.kind}>
      {editing.kind === 'creating-directory' ? <FolderPlus size={14} /> : <FilePlus2 size={14} />}
      <Input
        className="project-tree-edit-input"
        value={editing.value}
        disabled={editing.submitting === true}
        autoFocus
        onChange={(event) => onEditValueChange?.(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onEditSubmit?.();
          }
          if (event.key === 'Escape') {
            onEditCancel?.();
          }
        }}
        onBlur={() => onEditCancel?.()}
      />
      {editing.error ? <small>{editing.error}</small> : null}
    </div>
  );
}

function ProjectTreeRenameRow({
  node,
  depth,
  open,
  rowClassName,
  editing,
  onEditValueChange,
  onEditSubmit,
  onEditCancel
}: {
  node: ProjectFileTreeNode;
  depth: number;
  open?: boolean | undefined;
  rowClassName: string;
  editing: Extract<ProjectTreeInlineEditState, { kind: 'renaming' }>;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
}): React.ReactElement {
  const style = { '--tree-indent': `${depth * 14}px` } as React.CSSProperties;
  return (
    <div className={rowClassName} style={style} title={node.path} data-project-tree-context-path={node.path}>
      {node.kind === 'directory' ? (
        open ? <FolderOpen size={14} /> : <Folder size={14} />
      ) : <File size={14} />}
      <Input
        className="project-tree-edit-input"
        value={editing.value}
        disabled={editing.submitting === true}
        autoFocus
        data-project-tree-edit-kind="renaming"
        onChange={(event) => onEditValueChange?.(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            onEditSubmit?.();
          }
          if (event.key === 'Escape') {
            onEditCancel?.();
          }
        }}
        onBlur={() => onEditCancel?.()}
      />
      {editing.error ? <small>{editing.error}</small> : null}
    </div>
  );
}

function isCreatingInlineEditState(
  editing: ProjectTreeInlineEditState
): editing is Extract<ProjectTreeInlineEditState, { kind: 'creating-file' | 'creating-directory' }> {
  return editing.kind === 'creating-file' || editing.kind === 'creating-directory';
}
