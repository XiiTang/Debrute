import { PHOTOSHOP_MAX_BATCH_ITEMS } from '@debrute/app-protocol';
import {
  resolvePhotoshopDestination,
  type PhotoshopPluginRuntime,
  type PhotoshopPluginSnapshot
} from './PhotoshopPluginRuntime.js';

const TREE_INDENT_PX = 14;

export interface PhotoshopPanelPresentation {
  connectionLabel: string;
  connectionPresentation: 'connected' | 'waiting';
  sourceLabel: string;
  sourceProblem: string | null;
  destinationLabel: string;
  destinationStatus: 'empty' | 'pending' | 'valid';
  sendLabel: string;
  sendDisabled: boolean;
}

export interface DestinationTreeItemPresentation {
  kind: 'project' | 'directory';
  key: string;
  canonicalRoot: string;
  directory: string;
  label: string;
  depth: number;
  expanded: boolean;
  expandable: boolean;
  selected: boolean;
  children: DestinationTreeNodePresentation[];
}

export interface DestinationTreeStatePresentation {
  kind: 'state';
  state: 'loading' | 'error' | 'missing';
  key: string;
  label: string;
  depth: number;
}

export type DestinationTreeNodePresentation =
  | DestinationTreeItemPresentation
  | DestinationTreeStatePresentation;

export interface DestinationTreePresentation {
  roots: DestinationTreeItemPresentation[];
}

export function panelPresentation(snapshot: PhotoshopPluginSnapshot): PhotoshopPanelPresentation {
  const count = snapshot.selection.items.length;
  const documentTitle = snapshot.selection.documentTitle;
  const sourceLabel = documentTitle === null
    ? 'No open Document'
    : count === 0
      ? `${documentTitle} · Select layers or groups`
      : `${documentTitle} · ${count} selected`;
  const sourceProblem = count > PHOTOSHOP_MAX_BATCH_ITEMS
    ? `Select no more than ${PHOTOSHOP_MAX_BATCH_ITEMS} layers or groups.`
    : null;
  const destinationValid = resolvePhotoshopDestination(snapshot) !== null;
  const activeExport = snapshot.activeExport;
  return {
    connectionLabel: snapshot.connection.status === 'ready' ? 'Connected' : 'Waiting',
    connectionPresentation: snapshot.connection.status === 'ready' ? 'connected' : 'waiting',
    sourceLabel,
    sourceProblem,
    destinationLabel: destinationLabel(snapshot),
    destinationStatus: snapshot.destination === null
      ? 'empty'
      : destinationValid ? 'valid' : 'pending',
    sendLabel: activeExport === null
      ? `Send ${count} file${count === 1 ? '' : 's'}`
      : `Sending ${activeExport.itemCount} file${activeExport.itemCount === 1 ? '' : 's'} to ${activeExport.destinationLabel}…`,
    sendDisabled: snapshot.connection.status !== 'ready'
      || snapshot.busy
      || snapshot.selection.documentId === null
      || count === 0
      || count > PHOTOSHOP_MAX_BATCH_ITEMS
      || !destinationValid
  };
}

export function destinationTreePresentation(
  snapshot: PhotoshopPluginSnapshot
): DestinationTreePresentation {
  const expanded = new Set(snapshot.expandedDirectories.map((entry) => treeIdentity(
    entry.canonicalRoot,
    entry.directory
  )));
  const selected = snapshot.destination === null
    ? null
    : treeIdentity(snapshot.destination.canonicalRoot, snapshot.destination.directory);
  const roots = [...snapshot.projects]
    .sort((left, right) => naturalCompare(left.name, right.name))
    .map((project): DestinationTreeItemPresentation => {
      const key = treeIdentity(project.canonicalRoot, '');
      const isExpanded = expanded.has(key);
      let children: DestinationTreeNodePresentation[] = [];
      if (isExpanded) {
        children = directoryPageChildren({
          snapshot,
          canonicalRoot: project.canonicalRoot,
          projectRevision: project.revision,
          parentDirectory: '',
          depth: 1,
          expanded,
          selected
        });
      }
      return {
        kind: 'project',
        key,
        canonicalRoot: project.canonicalRoot,
        directory: '',
        label: project.name,
        depth: 0,
        expanded: isExpanded,
        expandable: true,
        selected: selected === key,
        children
      };
    });
  return { roots };
}

export class PhotoshopPanelView {
  private unsubscribe: (() => void) | undefined;
  private focusDestinationAfterRender = false;
  private revealDestinationAfterRender = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly runtime: PhotoshopPluginRuntime
  ) {}

  attach(): void {
    if (this.unsubscribe) return;
    this.revealDestinationAfterRender = true;
    this.unsubscribe = this.runtime.subscribe((snapshot) => this.render(snapshot));
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.root.replaceChildren();
  }

  private render(snapshot: PhotoshopPluginSnapshot): void {
    const presentation = panelPresentation(snapshot);
    const tree = destinationTreePresentation(snapshot);
    const hasVisibleSelectedDestination = flattenDestinationTree(tree.roots).some(({ item }) => (
      item.selected
    ));
    this.root.innerHTML = `
      <main class="photoshop-panel">
        <header class="photoshop-panel__header">
          <p class="photoshop-panel__brand">Debrute</p>
          <p class="photoshop-panel__connection photoshop-panel__connection--${presentation.connectionPresentation}">
            <span aria-hidden="true"></span>${escapeHtml(presentation.connectionLabel)}
          </p>
        </header>
        <section class="photoshop-panel__source" aria-label="Current Photoshop selection">
          <p class="photoshop-panel__source-summary">${escapeHtml(presentation.sourceLabel)}</p>
          ${presentation.sourceProblem === null
            ? ''
            : `<p class="photoshop-panel__source-problem">${escapeHtml(presentation.sourceProblem)}</p>`}
        </section>
        <section class="photoshop-panel__destination" aria-labelledby="destination-heading">
          <div class="photoshop-panel__destination-heading">
            <h1 id="destination-heading">Save to</h1>
            <p class="photoshop-panel__destination-path" title="${escapeHtml(presentation.destinationLabel)}">
              <span aria-hidden="true">${presentation.destinationStatus === 'valid'
                ? '✓'
                : presentation.destinationStatus === 'pending' ? '…' : '—'}</span>
              ${escapeHtml(presentation.destinationLabel)}
            </p>
          </div>
          <div class="photoshop-panel__browser">
            <div class="photoshop-panel__tree" role="tree" aria-label="Debrute Project directories" ${hasVisibleSelectedDestination ? '' : 'tabindex="0"'}>
              <div class="photoshop-panel__tree-content" role="none">
                ${tree.roots.map(renderDestinationTreeNode).join('')}
                ${tree.roots.length === 0
                  ? '<p class="photoshop-panel__tree-empty">No live Projects</p>'
                  : ''}
              </div>
            </div>
          </div>
        </section>
        <footer class="photoshop-panel__footer">
          ${snapshot.result === null
            ? ''
            : `<p class="photoshop-panel__result photoshop-panel__result--${snapshot.result.tone}" role="status">${escapeHtml(snapshot.result.message)}</p>`}
          <button class="photoshop-panel__send" type="button" data-action="send" ${presentation.sendDisabled ? 'disabled' : ''}>
            ${escapeHtml(presentation.sendLabel)}
          </button>
        </footer>
      </main>`;
    this.bind(tree);
    if ((this.focusDestinationAfterRender || this.revealDestinationAfterRender)
      && snapshot.destination !== null) {
      const destinationElement = findTreeItem(
        this.root,
        snapshot.destination.canonicalRoot,
        snapshot.destination.directory
      );
      if (destinationElement) {
        if (this.revealDestinationAfterRender
          && typeof destinationElement.scrollIntoViewIfNeeded === 'function') {
          destinationElement.scrollIntoViewIfNeeded();
        }
        if (this.focusDestinationAfterRender) destinationElement.focus();
        this.focusDestinationAfterRender = false;
        this.revealDestinationAfterRender = false;
      }
    } else if (snapshot.destination === null) {
      this.focusDestinationAfterRender = false;
      this.revealDestinationAfterRender = false;
    }
  }

  private bind(tree: DestinationTreePresentation): void {
    const visibleItems = flattenDestinationTree(tree.roots);
    for (const element of this.root.querySelectorAll<HTMLElement>('[role="treeitem"][data-canonical-root][data-directory]')) {
      element.addEventListener('click', () => {
        const canonicalRoot = element.getAttribute('data-canonical-root');
        const directory = element.getAttribute('data-directory');
        if (canonicalRoot !== null && directory !== null) {
          this.focusDestinationAfterRender = true;
          this.runtime.activateDestination(canonicalRoot, directory);
        }
      });
      element.addEventListener('keydown', (event) => {
        const canonicalRoot = element.getAttribute('data-canonical-root');
        const directory = element.getAttribute('data-directory');
        if (canonicalRoot === null || directory === null) return;
        const currentIndex = visibleItems.findIndex(({ item }) => (
          item.canonicalRoot === canonicalRoot && item.directory === directory
        ));
        if (currentIndex === -1) return;
        const current = visibleItems[currentIndex];
        if (!current) return;
        let handled = true;
        let action: (() => void) | undefined;
        if (event.key === 'ArrowUp') {
          const previous = visibleItems[currentIndex - 1]?.item;
          if (previous) action = () => this.runtime.selectDestination(previous.canonicalRoot, previous.directory);
        } else if (event.key === 'ArrowDown') {
          const next = visibleItems[currentIndex + 1]?.item;
          if (next) action = () => this.runtime.selectDestination(next.canonicalRoot, next.directory);
        } else if (event.key === 'ArrowRight') {
          if (current.item.expandable && !current.item.expanded) {
            action = () => this.runtime.expandDestination(canonicalRoot, directory);
          } else {
            const firstChild = current.item.children.find((child) => child.kind !== 'state');
            if (firstChild) {
              action = () => this.runtime.selectDestination(firstChild.canonicalRoot, firstChild.directory);
            }
          }
        } else if (event.key === 'ArrowLeft') {
          if (current.item.expanded) {
            action = () => this.runtime.collapseDestination(canonicalRoot, directory);
          } else if (current.parent) {
            const parent = current.parent;
            action = () => this.runtime.selectDestination(parent.canonicalRoot, parent.directory);
          }
        } else if (event.key === 'Enter' || event.key === ' ') {
          action = () => this.runtime.activateDestination(canonicalRoot, directory);
        } else {
          handled = false;
        }
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          if (action) {
            this.focusDestinationAfterRender = true;
            action();
          }
        }
      });
    }
    const treeElement = this.root.querySelector<HTMLElement>('[role="tree"]');
    treeElement?.addEventListener('keydown', (event) => {
      if (event.target !== treeElement || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const target = event.key === 'ArrowDown'
        ? visibleItems[0]?.item
        : visibleItems[visibleItems.length - 1]?.item;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      this.focusDestinationAfterRender = true;
      this.runtime.selectDestination(target.canonicalRoot, target.directory);
    });
    this.root.querySelector<HTMLButtonElement>('[data-action="send"]')?.addEventListener('click', () => {
      void this.runtime.sendSelection().catch(() => undefined);
    });
  }
}

function destinationLabel(snapshot: PhotoshopPluginSnapshot): string {
  const destination = snapshot.destination;
  if (destination === null) return 'No destination selected';
  return destination.directory === ''
    ? destination.projectName
    : `${destination.projectName} / ${destination.directory}`;
}

function naturalCompare(left: string, right: string): number {
  const primary = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  return primary === 0
    ? left.localeCompare(right, undefined, { numeric: true, sensitivity: 'variant' })
    : primary;
}

function directoryPageChildren(input: {
  snapshot: PhotoshopPluginSnapshot;
  canonicalRoot: string;
  projectRevision: number;
  parentDirectory: string;
  depth: number;
  expanded: ReadonlySet<string>;
  selected: string | null;
}): DestinationTreeNodePresentation[] {
  const page = input.snapshot.directoryPages.find((candidate) => (
    candidate.canonicalRoot === input.canonicalRoot
    && candidate.directory === input.parentDirectory
    && candidate.projectRevision === input.projectRevision
  ));
  if (!page || page.status === 'loading') {
    return [directoryState(input, 'loading', 'Loading directories…')];
  }
  if (page.status === 'missing') {
    return [directoryState(input, 'missing', 'Directory is no longer available.')];
  }
  if (page.status === 'error') {
    const detail = page.message?.trim();
    return [directoryState(
      input,
      'error',
      detail ? `Could not load directories: ${detail}` : 'Could not load directories.'
    )];
  }
  return [...page.childDirectories]
    .map((directory) => ({ directory, label: directoryLabel(directory) }))
    .sort((left, right) => naturalCompare(left.label, right.label))
    .map((child): DestinationTreeItemPresentation => {
      const key = treeIdentity(input.canonicalRoot, child.directory);
      const childPage = input.snapshot.directoryPages.find((candidate) => (
        candidate.canonicalRoot === input.canonicalRoot
        && candidate.directory === child.directory
        && candidate.projectRevision === input.projectRevision
      ));
      const expandable = childPage?.status !== 'loaded' || childPage.childDirectories.length > 0;
      const isExpanded = expandable && input.expanded.has(key);
      return {
        kind: 'directory',
        key,
        canonicalRoot: input.canonicalRoot,
        directory: child.directory,
        label: child.label,
        depth: input.depth,
        expanded: isExpanded,
        expandable,
        selected: input.selected === key,
        children: isExpanded
          ? directoryPageChildren({
              ...input,
              parentDirectory: child.directory,
              depth: input.depth + 1
            })
          : []
      };
    });
}

function directoryState(
  input: { canonicalRoot: string; parentDirectory: string; depth: number },
  state: DestinationTreeStatePresentation['state'],
  label: string
): DestinationTreeStatePresentation {
  return {
    kind: 'state',
    state,
    key: `${treeIdentity(input.canonicalRoot, input.parentDirectory)}:${state}`,
    label,
    depth: input.depth
  };
}

function directoryLabel(directory: string): string {
  return directory.slice(directory.lastIndexOf('/') + 1);
}

function treeIdentity(canonicalRoot: string, directory: string): string {
  return `${canonicalRoot.length}:${canonicalRoot}:${directory}`;
}

function renderDestinationTreeNode(node: DestinationTreeItemPresentation): string {
  const expandedAttribute = node.expandable ? ` aria-expanded="${node.expanded}"` : '';
  const groupId = node.children.length === 0
    ? null
    : `photoshop-directory-group-${encodeURIComponent(node.key)}`;
  const children = node.children.length === 0
    ? ''
    : `<div class="photoshop-panel__tree-group" id="${escapeHtml(groupId ?? '')}" role="group">
        ${node.children.map((child) => child.kind === 'state'
          ? `<p class="photoshop-panel__tree-state photoshop-panel__tree-state--${child.state}" role="status" style="--tree-indent: ${child.depth * TREE_INDENT_PX}px">
              ${treeGuideLines(child.depth)}${escapeHtml(child.label)}
            </p>`
          : renderDestinationTreeNode(child)).join('')}
      </div>`;
  return `<div class="photoshop-panel__tree-node" role="none">
    <div class="photoshop-panel__tree-row${node.selected ? ' photoshop-panel__tree-row--selected' : ''}" role="treeitem"
      data-canonical-root="${escapeHtml(node.canonicalRoot)}" data-directory="${escapeHtml(node.directory)}"
      aria-level="${node.depth + 1}" aria-selected="${node.selected}"${expandedAttribute}
      ${groupId === null ? '' : `aria-owns="${escapeHtml(groupId)}"`}
      style="--tree-indent: ${node.depth * TREE_INDENT_PX}px"
      tabindex="${node.selected ? '0' : '-1'}">
      ${treeGuideLines(node.depth)}
      ${folderIcon(node.expanded)}
      <span class="photoshop-panel__tree-label">${escapeHtml(node.label)}</span>
    </div>
    ${children}
  </div>`;
}

function folderIcon(open: boolean): string {
  return open
    ? `<svg data-debrute-icon="folder-open" aria-hidden="true" viewBox="0 0 20 20"><path d="M1 5h7l2 2h9l-3 11H1V5Zm3 5-1 6h11l2-6H4Z"/></svg>`
    : `<svg data-debrute-icon="folder" aria-hidden="true" viewBox="0 0 20 20"><path d="M1 4h7l2 2h9v12H1V4Z"/></svg>`;
}

function treeGuideLines(depth: number): string {
  return Array.from({ length: depth }, (_, index) => (
    `<span class="photoshop-panel__tree-guide" aria-hidden="true" style="left: ${(index + 1) * TREE_INDENT_PX}px"></span>`
  )).join('');
}

function flattenDestinationTree(
  roots: readonly DestinationTreeItemPresentation[]
): Array<{
  item: DestinationTreeItemPresentation;
  parent: DestinationTreeItemPresentation | null;
}> {
  const visible: Array<{
    item: DestinationTreeItemPresentation;
    parent: DestinationTreeItemPresentation | null;
  }> = [];
  const append = (
    item: DestinationTreeItemPresentation,
    parent: DestinationTreeItemPresentation | null
  ): void => {
    visible.push({ item, parent });
    for (const child of item.children) {
      if (child.kind !== 'state') append(child, item);
    }
  };
  for (const root of roots) append(root, null);
  return visible;
}

function findTreeItem(
  root: HTMLElement,
  canonicalRoot: string,
  directory: string
): UxpTreeItemElement | undefined {
  return [...root.querySelectorAll<UxpTreeItemElement>('[role="treeitem"]')].find((element) => (
    element.getAttribute('data-canonical-root') === canonicalRoot
    && element.getAttribute('data-directory') === directory
  ));
}

interface UxpTreeItemElement extends HTMLButtonElement {
  scrollIntoViewIfNeeded?: () => void;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
