import React from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { reorderCanvasIds } from './canvasCardBarState';
import { Button, IconButton, Input, Menu } from '../ui';

export interface CanvasCardBarProps {
  canvasOrder: string[];
  activeCanvasId: string | undefined;
  onActiveCanvasChange(canvasId: string): void;
  onCreateCanvas(): Promise<void>;
  onRenameCanvas(input: { canvasId: string; nextCanvasId: string }): Promise<void>;
  onDeleteCanvas(input: { canvasId: string }): Promise<void>;
  onReorderCanvases(input: { canvasOrder: string[] }): Promise<void>;
}

const DRAG_DATA_TYPE = 'application/x-debrute-canvas-id';
const MENU_WIDTH_PX = 176;
const MENU_VIEWPORT_PADDING_PX = 8;

export function CanvasCardBar({
  canvasOrder,
  activeCanvasId,
  onActiveCanvasChange,
  onCreateCanvas,
  onRenameCanvas,
  onDeleteCanvas,
  onReorderCanvases
}: CanvasCardBarProps): React.ReactElement {
  return (
    <nav className="db-floating-bar canvas-card-bar" aria-label="Canvases">
      <div className="canvas-card-scroll">
        {canvasOrder.map((canvasId) => (
          <div
            key={canvasId}
            className="canvas-card-wrap"
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              const draggedCanvasId = event.dataTransfer.getData(DRAG_DATA_TYPE);
              if (!draggedCanvasId) {
                return;
              }
              const nextOrder = reorderCanvasIds(canvasOrder, draggedCanvasId, canvasId);
              if (nextOrder !== canvasOrder) {
                void onReorderCanvases({ canvasOrder: nextOrder });
              }
            }}
          >
            <Button
              className="canvas-card db-canvas-card"
              size="sm"
              pressed={canvasId === activeCanvasId}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData(DRAG_DATA_TYPE, canvasId);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onActiveCanvasChange(canvasId)}
            >
              {canvasId}
            </Button>
            <details className="canvas-card-menu-details" onToggle={(event) => positionCanvasCardMenu(event.currentTarget)}>
              <summary aria-label="Canvas actions" className="canvas-card-menu-button db-icon-button db-icon-button--ghost db-icon-button--sm db-canvas-control" role="button">
                <MoreHorizontal size={14} />
              </summary>
              <Menu className="canvas-card-menu" ariaLabel={`${canvasId} canvas actions`}>
                <Menu.Item
                  onClick={(event) => {
                    closeCanvasCardMenu(event.currentTarget);
                    void onCreateCanvas();
                  }}
                >
                  New Canvas
                </Menu.Item>
                <form
                  className="canvas-card-rename-form"
                  onSubmit={(event) => submitRenameCanvas(event, canvasId, onRenameCanvas)}
                >
                  <Input
                    aria-label={`Rename ${canvasId}`}
                    name="nextCanvasId"
                    defaultValue={canvasId}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Menu.Item type="submit">Rename</Menu.Item>
                </form>
                <Menu.Item
                  data-canvas-delete-request
                  variant="danger"
                  onClick={(event) => requestDeleteCanvas(event.currentTarget)}
                >
                  Delete
                </Menu.Item>
                <Menu.Item
                  data-canvas-delete-confirm
                  hidden
                  variant="danger"
                  onClick={(event) => {
                    closeCanvasCardMenu(event.currentTarget);
                    void onDeleteCanvas({ canvasId });
                  }}
                >
                  Confirm Delete
                </Menu.Item>
              </Menu>
            </details>
          </div>
        ))}
      </div>
      <IconButton className="canvas-card-add db-canvas-control" label="New Canvas" icon={<Plus size={14} />} onClick={() => { void onCreateCanvas(); }} />
    </nav>
  );
}

function submitRenameCanvas(
  event: React.FormEvent<HTMLFormElement>,
  canvasId: string,
  onRenameCanvas: CanvasCardBarProps['onRenameCanvas']
): void {
  event.preventDefault();
  const control = event.currentTarget.elements.namedItem('nextCanvasId') as { value?: unknown } | null;
  const nextCanvasId = typeof control?.value === 'string' ? control.value.trim() : '';
  if (nextCanvasId && nextCanvasId !== canvasId) {
    closeCanvasCardMenu(event.currentTarget);
    void onRenameCanvas({ canvasId, nextCanvasId });
  }
}

function requestDeleteCanvas(button: HTMLButtonElement): void {
  const menu = button.closest('.canvas-card-menu');
  const confirmButton = menu?.querySelector<HTMLButtonElement>('[data-canvas-delete-confirm]');
  if (!confirmButton) {
    return;
  }
  button.hidden = true;
  confirmButton.hidden = false;
  confirmButton.focus();
}

function closeCanvasCardMenu(element: Element): void {
  element.closest('details')?.removeAttribute('open');
}

function positionCanvasCardMenu(details: HTMLDetailsElement): void {
  if (!details.open) {
    return;
  }
  const summary = details.querySelector('summary');
  if (!summary) {
    return;
  }
  const rect = summary.getBoundingClientRect();
  const viewportWidth = globalThis.window?.innerWidth ?? 1280;
  const viewportHeight = globalThis.window?.innerHeight ?? 720;
  const left = Math.round(clamp(
    rect.right - MENU_WIDTH_PX,
    MENU_VIEWPORT_PADDING_PX,
    viewportWidth - MENU_WIDTH_PX - MENU_VIEWPORT_PADDING_PX
  ));
  const bottom = Math.round(Math.max(
    MENU_VIEWPORT_PADDING_PX,
    viewportHeight - rect.top + 6
  ));
  details.style.setProperty('--canvas-card-menu-left', `${left}px`);
  details.style.setProperty('--canvas-card-menu-bottom', `${bottom}px`);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
