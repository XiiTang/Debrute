import React, { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Files, FolderPlus, FolderTree } from 'lucide-react';
import type { WorkbenchProjectSessionSnapshot } from '@debrute/app-protocol';
import type { WorkbenchActions } from '../../types';
import type { WorkbenchContextMenuPosition, WorkbenchContextMenuTarget } from '../shell/contextMenu';
import { buildProjectFileTree, expandedProjectTreePaths, findProjectFileTreeNode, type ProjectFileTreeNode } from './projectFileTree';
import type { ProjectTreeInlineEditState } from './projectTreeEditing';
import {
  projectTreeKeyboardCommandFromEvent,
  type ProjectTreeFileKeyboardCommand,
  type ProjectTreeKeyboardEventLike
} from './projectTreeKeyboardCommands';

export function ProjectTree({
  snapshot,
  selectedPath,
  cutPath,
  editing,
  actions,
  onOpenContextMenu,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onClearCut,
  desktopPlatform,
  onKeyboardFileCommand
}: {
  snapshot: WorkbenchProjectSessionSnapshot | undefined;
  selectedPath: string | undefined;
  cutPath?: string | undefined;
  editing?: ProjectTreeInlineEditState | undefined;
  actions: WorkbenchActions;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  desktopPlatform?: NodeJS.Platform | undefined;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
}): React.ReactElement {
  const tree = useMemo(() => buildProjectFileTree(snapshot?.files ?? []), [snapshot?.files]);
  const defaultExpanded = useMemo(() => expandedProjectTreePaths(tree, selectedPath), [tree, selectedPath]);
  const selectedNode = useMemo(() => findProjectFileTreeNode(tree, selectedPath), [selectedPath, tree]);
  const [expanded, setExpanded] = useState<Set<string>>(defaultExpanded);
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

  if (tree.length === 0) {
    return <div className="empty-line"><Files size={15} />No project files</div>;
  }

  return (
    <div className="project-tree-shell">
      <div
        className="project-tree"
        role="tree"
        aria-label="Project files"
        tabIndex={0}
        onKeyDown={(event) => handleProjectTreeKeyboardEvent({
          event,
          editing,
          selectedNode,
          desktopPlatform: desktopPlatform ?? 'linux',
          onEditCancel,
          onClearCut,
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
        {tree.map((node) => (
          <ProjectTreeRow
            key={node.path}
            node={node}
            depth={0}
            selectedPath={selectedPath}
            cutPath={cutPath}
            editing={editing}
            expanded={expanded}
            onToggle={(path) => setExpanded((current) => {
              const next = new Set(current);
              if (next.has(path)) {
                next.delete(path);
              } else {
                next.add(path);
              }
              return next;
            })}
            onSelect={actions.selectExplorerPath}
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
  selectedNode: ProjectFileTreeNode | undefined;
  desktopPlatform: NodeJS.Platform;
  onEditCancel?: (() => void) | undefined;
  onClearCut?: (() => void) | undefined;
  onKeyboardFileCommand?: ((command: ProjectTreeFileKeyboardCommand, target: WorkbenchContextMenuTarget) => void) | undefined;
}): void {
  if (input.event.key === 'Escape' && input.editing) {
    input.onEditCancel?.();
    return;
  }
  const command = projectTreeKeyboardCommandFromEvent(input.event, input.desktopPlatform);
  if (!command) {
    return;
  }
  input.event.preventDefault();
  input.event.stopPropagation();
  if (command === 'cancel-cut') {
    input.onClearCut?.();
    return;
  }
  if (!input.selectedNode) {
    return;
  }
  input.onKeyboardFileCommand?.(command, {
    source: 'explorer',
    kind: input.selectedNode.kind,
    projectRelativePath: input.selectedNode.path
  });
}

function ProjectTreeRow({
  node,
  depth,
  selectedPath,
  cutPath,
  editing,
  expanded,
  onToggle,
  onSelect,
  onOpenContextMenu,
  onEditValueChange,
  onEditSubmit,
  onEditCancel
}: {
  node: ProjectFileTreeNode;
  depth: number;
  selectedPath: string | undefined;
  cutPath: string | undefined;
  editing: ProjectTreeInlineEditState | undefined;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  onOpenContextMenu?: ((target: WorkbenchContextMenuTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
  onEditValueChange?: ((value: string) => void) | undefined;
  onEditSubmit?: (() => void) | undefined;
  onEditCancel?: (() => void) | undefined;
}): React.ReactElement {
  const selected = selectedPath === node.path;
  const style = { '--tree-indent': `${depth * 14}px` } as React.CSSProperties;
  const rowClassName = [
    'project-tree-row',
    selected ? 'selected' : '',
    cutPath === node.path ? 'cut' : ''
  ].filter(Boolean).join(' ');
  const renameEditing = editing?.kind === 'renaming' && editing.projectRelativePath === node.path ? editing : undefined;
  const createEditing = editing && isCreatingInlineEditState(editing) && editing.parentProjectRelativePath === node.path
    ? editing
    : undefined;
  const openContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(node.path);
    onOpenContextMenu?.({
      source: 'explorer',
      kind: node.kind,
      projectRelativePath: node.path
    }, {
      x: event.clientX,
      y: event.clientY
    });
  };

  if (node.kind === 'directory') {
    const open = expanded.has(node.path);
    return (
      <div role="treeitem" aria-expanded={open}>
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
            onClick={() => {
              onSelect(node.path);
              onToggle(node.path);
            }}
            onContextMenu={openContextMenu}
          >
            <span className={open ? 'tree-chevron open' : 'tree-chevron'} />
            <FolderTree size={14} />
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
                selectedPath={selectedPath}
                cutPath={cutPath}
                editing={editing}
                expanded={expanded}
                onToggle={onToggle}
                onSelect={onSelect}
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
      onClick={() => onSelect(node.path)}
      onContextMenu={openContextMenu}
    >
      <span className="tree-chevron-spacer" />
      <Files size={14} />
      <span>{node.name}</span>
    </button>
  );
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
      <span className="tree-chevron-spacer" />
      {editing.kind === 'creating-directory' ? <FolderPlus size={14} /> : <FilePlus2 size={14} />}
      <input
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
      {node.kind === 'directory' ? <span className={open ? 'tree-chevron open' : 'tree-chevron'} /> : <span className="tree-chevron-spacer" />}
      {node.kind === 'directory' ? <FolderTree size={14} /> : <Files size={14} />}
      <input
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
