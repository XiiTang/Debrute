import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { flushSync } from 'react-dom';
import '../styles/explorer.css';
import type {
  DebruteProductPlatform,
  ProjectPathRef,
  ProjectTreeEntry,
  WorkbenchProjectSessionSnapshot
} from '@debrute/app-protocol';
import { getDebruteShellApi } from '../../api/shellApi';
import {
  projectPathBasename,
  projectPathParent,
  type ProjectPathCommandEntry,
  type ProjectPathCommandTarget
} from '../services/projectPathCommandTarget';
import type {
  WorkbenchContextMenuPosition
} from '../shell/contextMenu';
import { ChevronRight, EmptyState, File, FilePlus2, Folder, FolderOpen, FolderPlus, Input, cx } from '../ui/index';
import { useI18n } from '../i18n';
import {
  createProjectExternalDropSource,
  hasProjectTreeExternalDrag,
  type ProjectExternalDropSource
} from './projectTreeExternalDrop';
import {
  projectExplorerSelectionFromPaths,
  type InlineProjectEdit,
  type ProjectExplorerViewState,
  type ProjectExplorerSelection
} from './useProjectExplorerController';

export const PROJECT_TREE_ROW_HEIGHT = 28;
export const PROJECT_TREE_DRAG_MIME = 'application/x-debrute-project-tree';
const PROJECT_TREE_OVERSCAN = 4;
const PROJECT_TREE_INITIAL_ROWS = 8;

export type ProjectExplorerRow =
  | {
      kind: 'entry';
      entry: ProjectTreeEntry;
      label: string;
      depth: number;
      parentIndex: number;
      positionInSet: number;
      setSize: number;
    }
  | {
      kind: 'create';
      parentProjectRelativePath: string;
      depth: number;
      parentIndex: number;
    };

export interface ProjectTreeViewportRange {
  start: number;
  end: number;
}

export function projectTreeViewportRange(input: {
  scrollTop: number;
  clientHeight: number;
  rowCount: number;
  overscan?: number;
}): ProjectTreeViewportRange {
  const overscan = input.overscan ?? PROJECT_TREE_OVERSCAN;
  return {
    start: Math.max(0, Math.floor(input.scrollTop / PROJECT_TREE_ROW_HEIGHT) - overscan),
    end: Math.min(
      input.rowCount,
      Math.ceil((input.scrollTop + input.clientHeight) / PROJECT_TREE_ROW_HEIGHT) + overscan
    )
  };
}

export function projectExplorerRows(
  projectTree: readonly ProjectTreeEntry[],
  expanded: ReadonlySet<string>,
  edit: InlineProjectEdit | undefined
): ProjectExplorerRow[] {
  const visible: Array<{
    entry: ProjectTreeEntry;
    label: string;
    depth: number;
    parentPath: string;
  }> = [];
  let collapsedDepth: number | undefined;
  for (const entry of projectTree) {
    if (!entry.projectRelativePath) {
      continue;
    }
    const depth = projectPathDepth(entry.projectRelativePath);
    if (collapsedDepth !== undefined) {
      if (depth > collapsedDepth) {
        continue;
      }
      collapsedDepth = undefined;
    }
    visible.push({
      entry,
      label: projectPathBasename(entry.projectRelativePath),
      depth,
      parentPath: projectPathParent(entry.projectRelativePath)
    });
    if (entry.kind === 'directory' && !expanded.has(entry.projectRelativePath)) {
      collapsedDepth = depth;
    }
  }

  const siblingCounts = new Map<string, number>();
  for (const item of visible) {
    siblingCounts.set(item.parentPath, (siblingCounts.get(item.parentPath) ?? 0) + 1);
  }
  const siblingPositions = new Map<string, number>();
  const rawRows: Array<ProjectExplorerRow & { parentPath?: string }> = visible.map((item) => {
    const positionInSet = (siblingPositions.get(item.parentPath) ?? 0) + 1;
    siblingPositions.set(item.parentPath, positionInSet);
    return {
      kind: 'entry',
      entry: item.entry,
      label: item.label,
      depth: item.depth,
      parentIndex: -1,
      parentPath: item.parentPath,
      positionInSet,
      setSize: siblingCounts.get(item.parentPath) ?? 1
    };
  });

  if (edit?.target.kind === 'create') {
    const parent = edit.target.parentProjectRelativePath;
    const parentIndex = parent
      ? rawRows.findIndex((row) => row.kind === 'entry' && row.entry.projectRelativePath === parent)
      : -1;
    if (!parent || parentIndex >= 0) {
      rawRows.splice(parentIndex + 1, 0, {
        kind: 'create',
        parentProjectRelativePath: parent,
        depth: parent ? projectPathDepth(parent) + 1 : 0,
        parentIndex
      });
    }
  }

  const rowIndexByPath = new Map<string, number>();
  rawRows.forEach((row, index) => {
    if (row.kind === 'entry') {
      rowIndexByPath.set(row.entry.projectRelativePath, index);
    }
  });
  return rawRows.map((row) => {
    if (row.kind === 'create') {
      return {
        ...row,
        parentIndex: row.parentProjectRelativePath
          ? rowIndexByPath.get(row.parentProjectRelativePath) ?? -1
          : -1
      };
    }
    const { parentPath: rowParentPath, ...entryRow } = row;
    return {
      ...entryRow,
      parentIndex: rowParentPath ? rowIndexByPath.get(rowParentPath) ?? -1 : -1
    };
  });
}

export function ProjectTree({
  generation,
  snapshot,
  state,
  productPlatform,
  onSelectionChange,
  onToggleDirectory,
  onBeginRename,
  onBeginCreate,
  onEditValueChange,
  onEditSubmit,
  onEditCancel,
  onInternalDrop,
  onExternalDrop,
  onExternalDropError,
  onLocateFileInCanvas,
  onOpenContextMenu
}: {
  generation: number;
  snapshot: WorkbenchProjectSessionSnapshot;
  state: ProjectExplorerViewState;
  productPlatform: DebruteProductPlatform;
  onSelectionChange(selection: ProjectExplorerSelection): void;
  onToggleDirectory(projectRelativePath: string): void;
  onBeginRename(entry: ProjectPathRef): void;
  onBeginCreate(kind: 'file' | 'directory', parentProjectRelativePath: string): void;
  onEditValueChange(value: string): void;
  onEditSubmit(): void;
  onEditCancel(): void;
  onInternalDrop(input: {
    operation: 'copy' | 'move';
    entries: readonly ProjectPathRef[];
    targetDirectoryProjectRelativePath: string;
  }): void;
  onExternalDrop(source: ProjectExternalDropSource, targetDirectoryProjectRelativePath: string): void;
  onExternalDropError(): void;
  onLocateFileInCanvas?: ((projectRelativePath: string) => void) | undefined;
  onOpenContextMenu?: ((target: ProjectPathCommandTarget, position: WorkbenchContextMenuPosition) => void) | undefined;
}): React.ReactElement {
  const i18n = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const previousEditRef = useRef(state.edit);
  const dragEntriesRef = useRef<readonly ProjectPathRef[] | undefined>(undefined);
  const dragTargetRef = useRef<HTMLElement | undefined>(undefined);
  const mountedGenerationRef = useRef(generation);
  const rows = useMemo(
    () => projectExplorerRows(snapshot.projectTree, state.expanded, state.edit),
    [snapshot.projectTree, state.edit?.target, state.expanded]
  );
  const rowIndexByPath = useMemo(() => new Map(rows.flatMap((row, index) => (
    row.kind === 'entry' ? [[row.entry.projectRelativePath, index] as const] : []
  ))), [rows]);
  const entryByPath = useMemo(() => new Map(snapshot.projectTree.map((entry) => [
    entry.projectRelativePath,
    entry
  ])), [snapshot.projectTree]);
  const [range, setRange] = useState<ProjectTreeViewportRange>(() => ({
    start: 0,
    end: Math.min(rows.length, PROJECT_TREE_INITIAL_ROWS)
  }));
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const rowCountRef = useRef(rows.length);
  rowCountRef.current = rows.length;
  const focusRoot = useCallback(() => rootRef.current?.focus({ preventScroll: true }), []);

  useLayoutEffect(() => {
    const editEnded = previousEditRef.current !== undefined && state.edit === undefined;
    previousEditRef.current = state.edit;
    if (editEnded) {
      focusRoot();
    }
  }, [focusRoot, state.edit]);

  const updateRange = useCallback((synchronousGrowth = false) => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const next = projectTreeViewportRange({
      scrollTop: root.scrollTop,
      clientHeight: root.clientHeight,
      rowCount: rowCountRef.current
    });
    if (next.start === rangeRef.current.start && next.end === rangeRef.current.end) {
      return;
    }
    const commit = () => {
      rangeRef.current = next;
      setRange(next);
    };
    if (synchronousGrowth && next.end > rangeRef.current.end) {
      flushSync(commit);
    } else {
      commit();
    }
  }, []);

  useLayoutEffect(() => {
    updateRange();
  }, [rows.length, updateRange]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') {
      return;
    }
    let previousHeight = root.clientHeight;
    const observer = new ResizeObserver((entries) => {
      const nextHeight = entries[0]?.contentRect.height ?? root.clientHeight;
      if (nextHeight === previousHeight) {
        return;
      }
      const grew = nextHeight > previousHeight;
      previousHeight = nextHeight;
      updateRange(grew);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [updateRange]);

  const clearDragState = useCallback(() => {
    dragEntriesRef.current = undefined;
    clearDragTarget();
  }, []);

  const clearDragTarget = () => {
    if (dragTargetRef.current) {
      dragTargetRef.current.classList.remove('drag-over');
      dragTargetRef.current = undefined;
    }
  };

  useLayoutEffect(() => {
    mountedGenerationRef.current = generation;
    window.addEventListener('blur', clearDragState);
    return () => {
      mountedGenerationRef.current = -1;
      window.removeEventListener('blur', clearDragState);
      clearDragState();
    };
  }, [clearDragState, generation]);

  const pinnedIndices = new Set<number>();
  if (state.selection.focusedPath) {
    const focusedIndex = rowIndexByPath.get(state.selection.focusedPath);
    if (focusedIndex !== undefined) {
      pinnedIndices.add(focusedIndex);
    }
  }
  if (state.edit?.target.kind === 'rename') {
    const editIndex = rowIndexByPath.get(state.edit.target.entry.projectRelativePath);
    if (editIndex !== undefined) {
      pinnedIndices.add(editIndex);
    }
  } else if (state.edit?.target.kind === 'create') {
    const createIndex = rows.findIndex((row) => row.kind === 'create');
    if (createIndex >= 0) {
      pinnedIndices.add(createIndex);
    }
  }
  const mountedIndices = [...new Set([
    ...Array.from({ length: Math.max(0, range.end - range.start) }, (_, offset) => range.start + offset),
    ...pinnedIndices
  ])].filter((index) => index >= 0 && index < rows.length).sort((left, right) => left - right);
  const focusedIndex = state.selection.focusedPath
    ? rowIndexByPath.get(state.selection.focusedPath)
    : undefined;
  const activeDescendant = focusedIndex === undefined
    ? undefined
    : projectTreeRowId(generation, focusedIndex);
  const cutPaths = state.clipboard?.operation === 'cut'
    ? new Set(state.clipboard.entries.map((entry) => entry.projectRelativePath))
    : new Set<string>();

  const rowFromEvent = (event: { target: EventTarget | null; currentTarget: EventTarget & HTMLDivElement }) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-row-index]')
      : null;
    if (!target || !event.currentTarget.contains(target)) {
      return undefined;
    }
    const index = Number(target.dataset.rowIndex);
    return Number.isSafeInteger(index) && rows[index]
      ? { index, row: rows[index]!, element: target }
      : undefined;
  };

  const entriesForSelection = (selection: ProjectExplorerSelection): ProjectPathCommandEntry[] => {
    return selection.selectedPaths.flatMap((path) => {
      const entry = entryByPath.get(path);
      return entry ? [{ projectRelativePath: path, kind: entry.kind }] : [];
    });
  };

  return (
    <div className="project-tree-shell">
      <div
        ref={rootRef}
        className="project-tree"
        role="tree"
        aria-label={i18n.t('explorer.projectFiles')}
        aria-activedescendant={activeDescendant}
        tabIndex={0}
        style={{
          '--project-tree-row-height': `${PROJECT_TREE_ROW_HEIGHT}px`
        } as React.CSSProperties}
        onScroll={() => updateRange()}
        onClick={(event) => {
          if (isProjectTreeEditTarget(event.target)) {
            return;
          }
          const hit = rowFromEvent(event);
          if (!hit || hit.row.kind !== 'entry') {
            if (!hit) {
              onSelectionChange(emptySelection());
              focusRoot();
            }
            return;
          }
          const selection = selectionForPointer({
            current: state.selection,
            rows,
            path: hit.row.entry.projectRelativePath,
            platform: productPlatform,
            event
          });
          onSelectionChange(selection);
          if (
            hit.row.entry.kind === 'directory'
            && !event.shiftKey
            && !selectionModifier(event, productPlatform)
          ) {
            onToggleDirectory(hit.row.entry.projectRelativePath);
          }
          focusRoot();
        }}
        onDoubleClick={(event) => {
          if (isProjectTreeEditTarget(event.target)) {
            return;
          }
          const hit = rowFromEvent(event);
          if (!hit) {
            onBeginCreate('file', '');
          } else if (hit.row.kind === 'entry' && hit.row.entry.kind === 'file') {
            onLocateFileInCanvas?.(hit.row.entry.projectRelativePath);
          }
        }}
        onContextMenu={(event) => {
          if (isProjectTreeEditTarget(event.target)) {
            return;
          }
          event.preventDefault();
          const hit = rowFromEvent(event);
          if (!hit || hit.row.kind !== 'entry') {
            onSelectionChange(emptySelection());
            onOpenContextMenu?.({
              source: 'explorer',
              invocation: { projectRelativePath: '', kind: 'directory' },
              selection: []
            }, { x: event.clientX, y: event.clientY });
            return;
          }
          const path = hit.row.entry.projectRelativePath;
          const selection = state.selection.selectedPaths.includes(path)
            ? state.selection
            : projectExplorerSelectionFromPaths([path]);
          if (selection !== state.selection) {
            onSelectionChange(selection);
          }
          onOpenContextMenu?.({
            source: 'explorer',
            invocation: { projectRelativePath: path, kind: hit.row.entry.kind },
            selection: entriesForSelection(selection)
          }, { x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) {
            return;
          }
          const handled = handleNavigationKey({
            key: event.key,
            rows,
            rowIndexByPath,
            selection: state.selection,
            expanded: state.expanded,
            onSelectionChange: (selection) => {
              onSelectionChange(selection);
              const path = selection.focusedPath;
              const index = path ? rowIndexByPath.get(path) : undefined;
              if (index !== undefined) {
                scrollRowIntoView(rootRef.current, index);
              }
            },
            onToggleDirectory,
            onBeginRename
          });
          if (handled) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onDragStart={(event) => {
          const hit = rowFromEvent(event);
          if (!hit || hit.row.kind !== 'entry') {
            return;
          }
          const path = hit.row.entry.projectRelativePath;
          const selection = state.selection.selectedPaths.includes(path)
            ? state.selection
            : projectExplorerSelectionFromPaths([path]);
          if (selection !== state.selection) {
            onSelectionChange(selection);
          }
          const entries = entriesForSelection(selection);
          if (entries.length === 0) {
            return;
          }
          dragEntriesRef.current = entries;
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData(PROJECT_TREE_DRAG_MIME, '1');
        }}
        onDragOver={(event) => {
          const internal = Array.from(event.dataTransfer.types).includes(PROJECT_TREE_DRAG_MIME)
            && Boolean(dragEntriesRef.current?.length);
          if (!internal && !hasProjectTreeExternalDrag(event.dataTransfer)) {
            return;
          }
          const hit = rowFromEvent(event);
          const target = dropTargetDirectory(hit?.row);
          if (internal && internalDropRejected(dragEntriesRef.current ?? [], target)) {
            clearDragTarget();
            return;
          }
          event.preventDefault();
          const targetElement = hit?.element ?? event.currentTarget;
          if (dragTargetRef.current !== targetElement) {
            dragTargetRef.current?.classList.remove('drag-over');
            targetElement.classList.add('drag-over');
            dragTargetRef.current = targetElement;
          }
        }}
        onDrop={(event) => {
          const hit = rowFromEvent(event);
          const targetDirectoryProjectRelativePath = dropTargetDirectory(hit?.row);
          const internalEntries = dragEntriesRef.current;
          event.preventDefault();
          clearDragState();
          if (internalEntries?.length) {
            if (!internalDropRejected(internalEntries, targetDirectoryProjectRelativePath)) {
              onInternalDrop({
                entries: internalEntries,
                targetDirectoryProjectRelativePath,
                operation: dropOperation(event, productPlatform)
              });
            }
            return;
          }
          if (hasProjectTreeExternalDrag(event.dataTransfer)) {
            const dropGeneration = generation;
            void createProjectExternalDropSource({
              dataTransfer: event.dataTransfer,
              shell: getDebruteShellApi()
            }).then(
              (source) => {
                if (mountedGenerationRef.current === dropGeneration) {
                  onExternalDrop(source, targetDirectoryProjectRelativePath);
                }
              },
              () => {
                if (mountedGenerationRef.current === dropGeneration) {
                  onExternalDropError();
                }
              }
            );
          }
        }}
        onDragEnd={clearDragState}
      >
        <div
          className="project-tree-spacer"
          style={{ height: rows.length * PROJECT_TREE_ROW_HEIGHT }}
          aria-hidden="true"
        />
        {rows.length === 0 ? (
          <EmptyState className="project-tree-empty" title={i18n.t('explorer.noProjectFiles')} />
        ) : null}
        {mountedIndices.map((index) => {
          const row = rows[index]!;
          const style = {
            '--tree-indent': `${row.depth * 14}px`,
            transform: `translateY(${index * PROJECT_TREE_ROW_HEIGHT}px)`
          } as React.CSSProperties;
          if (row.kind === 'create') {
            return state.edit?.target.kind === 'create' ? (
              <ProjectTreeEditRow
                key={`create-${state.edit.revision}`}
                index={index}
                style={style}
                edit={state.edit}
                onValueChange={onEditValueChange}
                onSubmit={onEditSubmit}
                onCancel={onEditCancel}
              />
            ) : null;
          }
          const selected = state.selection.selectedPaths.includes(row.entry.projectRelativePath);
          const focused = state.selection.focusedPath === row.entry.projectRelativePath;
          const rename = state.edit?.target.kind === 'rename'
            && state.edit.target.entry.projectRelativePath === row.entry.projectRelativePath
            ? state.edit
            : undefined;
          return (
            <div
              key={row.entry.projectRelativePath}
              id={projectTreeRowId(generation, index)}
              className={cx(
                'project-tree-row',
                'db-tree-row',
                selected && 'selected',
                focused && 'focused',
                cutPaths.has(row.entry.projectRelativePath) && 'cut',
                row.entry.directoryState === 'error' && 'error'
              )}
              data-row-index={index}
              draggable={!rename}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-posinset={row.positionInSet}
              aria-setsize={row.setSize}
              aria-selected={selected}
              aria-expanded={row.entry.kind === 'directory'
                ? state.expanded.has(row.entry.projectRelativePath)
                : undefined}
              title={row.entry.directoryError}
              style={style}
            >
              {row.entry.kind === 'directory' ? (
                <span className={cx(
                  'project-tree-disclosure',
                  state.expanded.has(row.entry.projectRelativePath) && 'expanded'
                )} aria-hidden="true"><ChevronRight size={12} /></span>
              ) : <span className="project-tree-disclosure" />}
              {row.entry.kind === 'directory'
                ? state.expanded.has(row.entry.projectRelativePath) ? <FolderOpen size={14} /> : <Folder size={14} />
                : <File size={14} />}
              {rename ? (
                <ProjectTreeEditInput
                  edit={rename}
                  onValueChange={onEditValueChange}
                  onSubmit={onEditSubmit}
                  onCancel={onEditCancel}
                />
              ) : <span className="project-tree-label">{row.label}</span>}
              {row.entry.directoryError ? (
                <span className="project-tree-accessible-status" role="status">
                  {row.entry.directoryError}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ProjectTreeEditRow({
  index,
  style,
  edit,
  onValueChange,
  onSubmit,
  onCancel
}: {
  index: number;
  style: React.CSSProperties;
  edit: InlineProjectEdit;
  onValueChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
}): React.ReactElement {
  if (edit.target.kind !== 'create') {
    throw new Error('Project Tree create row requires a create edit target.');
  }
  return (
    <div
      className="project-tree-edit-row"
      data-row-index={index}
      data-project-tree-edit-kind={`creating-${edit.target.entryKind}`}
      style={style}
    >
      <span className="project-tree-disclosure" />
      {edit.target.entryKind === 'file' ? <FilePlus2 size={14} /> : <FolderPlus size={14} />}
      <ProjectTreeEditInput
        edit={edit}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    </div>
  );
}

function ProjectTreeEditInput({
  edit,
  onValueChange,
  onSubmit,
  onCancel
}: {
  edit: InlineProjectEdit;
  onValueChange(value: string): void;
  onSubmit(): void;
  onCancel(): void;
}): React.ReactElement {
  return (
    <span className="project-tree-edit-control">
      <Input
        autoFocus
        className={cx('project-tree-edit-input', edit.phase === 'editing' && edit.error && 'error')}
        value={edit.value}
        readOnly={edit.phase === 'submitting'}
        aria-busy={edit.phase === 'submitting' || undefined}
        aria-invalid={Boolean(edit.phase === 'editing' && edit.error) || undefined}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onBlur={() => {
          if (edit.phase === 'editing') {
            onCancel();
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== 'Escape') {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          if (edit.phase === 'submitting') {
            return;
          }
          if (event.key === 'Enter') {
            onSubmit();
          } else {
            onCancel();
          }
        }}
      />
      {edit.phase === 'editing' && edit.error ? (
        <span className="project-tree-edit-error" role="status">{edit.error}</span>
      ) : null}
    </span>
  );
}

function handleNavigationKey(input: {
  key: string;
  rows: readonly ProjectExplorerRow[];
  rowIndexByPath: ReadonlyMap<string, number>;
  selection: ProjectExplorerSelection;
  expanded: ReadonlySet<string>;
  onSelectionChange(selection: ProjectExplorerSelection): void;
  onToggleDirectory(path: string): void;
  onBeginRename(entry: ProjectPathRef): void;
}): boolean {
  const firstIndex = nextEntryIndex(input.rows, -1, 1);
  const lastIndex = nextEntryIndex(input.rows, input.rows.length, -1);
  if (firstIndex === undefined || lastIndex === undefined) {
    return false;
  }
  const currentIndex = input.selection.focusedPath
    ? input.rowIndexByPath.get(input.selection.focusedPath)
    : undefined;
  const selectAt = (index: number | undefined) => {
    const selected = index === undefined ? undefined : input.rows[index];
    if (selected?.kind === 'entry') {
      input.onSelectionChange(projectExplorerSelectionFromPaths([selected.entry.projectRelativePath]));
    }
  };
  if (input.key === 'ArrowDown') {
    selectAt(currentIndex === undefined
      ? firstIndex
      : nextEntryIndex(input.rows, currentIndex, 1));
    return true;
  }
  if (input.key === 'ArrowUp') {
    selectAt(currentIndex === undefined
      ? lastIndex
      : nextEntryIndex(input.rows, currentIndex, -1));
    return true;
  }
  if (input.key === 'Home') {
    selectAt(firstIndex);
    return true;
  }
  if (input.key === 'End') {
    selectAt(lastIndex);
    return true;
  }
  if (currentIndex === undefined) {
    return false;
  }
  const current = input.rows[currentIndex];
  if (!current || current.kind !== 'entry') {
    return false;
  }
  if (input.key === 'F2') {
    input.onBeginRename(current.entry);
    return true;
  }
  if (input.key === 'Enter' && current.entry.kind === 'directory') {
    input.onToggleDirectory(current.entry.projectRelativePath);
    return true;
  }
  if (input.key === 'ArrowRight' && current.entry.kind === 'directory') {
    if (!input.expanded.has(current.entry.projectRelativePath)) {
      input.onToggleDirectory(current.entry.projectRelativePath);
    } else {
      const nextIndex = nextEntryIndex(input.rows, currentIndex, 1);
      const next = nextIndex === undefined ? undefined : input.rows[nextIndex];
      if (next?.kind === 'entry' && next.depth > current.depth) {
        input.onSelectionChange(projectExplorerSelectionFromPaths([next.entry.projectRelativePath]));
      }
    }
    return true;
  }
  if (input.key === 'ArrowLeft') {
    if (current.entry.kind === 'directory' && input.expanded.has(current.entry.projectRelativePath)) {
      input.onToggleDirectory(current.entry.projectRelativePath);
      return true;
    }
    if (current.parentIndex >= 0) {
      const parent = input.rows[current.parentIndex];
      if (parent?.kind === 'entry') {
        input.onSelectionChange(projectExplorerSelectionFromPaths([parent.entry.projectRelativePath]));
        return true;
      }
    }
  }
  return false;
}

function nextEntryIndex(
  rows: readonly ProjectExplorerRow[],
  from: number,
  direction: -1 | 1
): number | undefined {
  for (let index = from + direction; index >= 0 && index < rows.length; index += direction) {
    if (rows[index]?.kind === 'entry') {
      return index;
    }
  }
  return undefined;
}

function selectionForPointer(input: {
  current: ProjectExplorerSelection;
  rows: readonly ProjectExplorerRow[];
  path: string;
  platform: DebruteProductPlatform;
  event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>;
}): ProjectExplorerSelection {
  if (input.event.shiftKey && input.current.anchorPath) {
    const visiblePaths = input.rows.flatMap((row) => row.kind === 'entry'
      ? [row.entry.projectRelativePath]
      : []);
    const anchorIndex = visiblePaths.indexOf(input.current.anchorPath);
    const targetIndex = visiblePaths.indexOf(input.path);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const selectedPaths = visiblePaths.slice(
        Math.min(anchorIndex, targetIndex),
        Math.max(anchorIndex, targetIndex) + 1
      );
      return {
        selectedPaths,
        focusedPath: input.path,
        anchorPath: input.current.anchorPath
      };
    }
  }
  if (selectionModifier(input.event, input.platform)) {
    const selectedPaths = input.current.selectedPaths.includes(input.path)
      ? input.current.selectedPaths.filter((path) => path !== input.path)
      : [...input.current.selectedPaths, input.path];
    return {
      selectedPaths,
      focusedPath: selectedPaths.includes(input.path) ? input.path : selectedPaths.at(-1) ?? null,
      anchorPath: selectedPaths.includes(input.path) ? input.path : input.current.anchorPath
    };
  }
  return projectExplorerSelectionFromPaths([input.path]);
}

function selectionModifier(
  event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey'>,
  platform: DebruteProductPlatform
): boolean {
  return platform === 'darwin' ? event.metaKey : event.ctrlKey;
}

function dropOperation(
  event: Pick<React.DragEvent, 'altKey' | 'ctrlKey'>,
  platform: DebruteProductPlatform
): 'copy' | 'move' {
  return platform === 'darwin'
    ? event.altKey ? 'copy' : 'move'
    : event.ctrlKey ? 'copy' : 'move';
}

function dropTargetDirectory(row: ProjectExplorerRow | undefined): string {
  if (!row || row.kind === 'create') {
    return '';
  }
  return row.entry.kind === 'directory'
    ? row.entry.projectRelativePath
    : projectPathParent(row.entry.projectRelativePath);
}

function internalDropRejected(entries: readonly ProjectPathRef[], target: string): boolean {
  return entries.some((entry) => entry.kind === 'directory' && (
    target === entry.projectRelativePath || target.startsWith(`${entry.projectRelativePath}/`)
  ));
}

function scrollRowIntoView(root: HTMLDivElement | null, index: number): void {
  if (!root) {
    return;
  }
  const top = index * PROJECT_TREE_ROW_HEIGHT;
  const bottom = top + PROJECT_TREE_ROW_HEIGHT;
  if (top < root.scrollTop) {
    root.scrollTop = top;
  } else if (bottom > root.scrollTop + root.clientHeight) {
    root.scrollTop = bottom - root.clientHeight;
  }
}

function projectTreeRowId(generation: number, index: number): string {
  return `project-tree-${generation}-${index}`;
}

function emptySelection(): ProjectExplorerSelection {
  return { selectedPaths: [], focusedPath: null, anchorPath: null };
}

function isProjectTreeEditTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('.project-tree-edit-control'));
}

function projectPathDepth(path: string): number {
  return path.split('/').length - 1;
}
