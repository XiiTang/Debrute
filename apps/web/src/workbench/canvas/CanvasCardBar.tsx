import React from 'react';
import { Plus } from 'lucide-react';
import { reorderCanvasIds } from './canvasCardBarState';
import { Button, CloseButton, IconButton } from '../ui';
import { useI18n } from '../i18n';

export interface CanvasCardBarItem {
  id: string;
  name: string;
}

export interface CanvasCardBarProps {
  canvases: CanvasCardBarItem[];
  activeCanvasId: string | undefined;
  onActiveCanvasChange(canvasId: string): void;
  onCreateCanvas(): Promise<void>;
  onRenameCanvas(input: { canvasId: string; name: string }): Promise<void>;
  onDeleteCanvas(input: { canvasId: string }): Promise<void>;
  onReorderCanvases(input: { canvasOrder: string[] }): Promise<void>;
}

const DRAG_DATA_TYPE = 'application/x-debrute-canvas-id';

export function CanvasCardBar({
  canvases,
  activeCanvasId,
  onActiveCanvasChange,
  onCreateCanvas,
  onRenameCanvas,
  onDeleteCanvas,
  onReorderCanvases
}: CanvasCardBarProps): React.ReactElement {
  const i18n = useI18n();
  const canvasOrder = React.useMemo(() => canvases.map((canvas) => canvas.id), [canvases]);
  const [editingCanvasId, setEditingCanvasId] = React.useState<string>();
  const editingInputRef = React.useRef<HTMLInputElement | null>(null);
  const renameFinishedRef = React.useRef(false);

  React.useEffect(() => {
    const input = editingInputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    input.select();
  }, [editingCanvasId]);

  const beginRename = (canvasId: string): void => {
    renameFinishedRef.current = false;
    setEditingCanvasId(canvasId);
  };
  const completeRename = (canvas: CanvasCardBarItem, value: string): void => {
    if (renameFinishedRef.current) {
      return;
    }
    renameFinishedRef.current = true;
    const name = value.trim();
    if (name && name !== canvas.name) {
      void onRenameCanvas({ canvasId: canvas.id, name });
    }
    setEditingCanvasId(undefined);
  };
  const cancelRename = (): void => {
    renameFinishedRef.current = true;
    setEditingCanvasId(undefined);
  };

  return (
    <nav className="db-floating-bar canvas-card-bar" aria-label={i18n.t('canvas.cardBar.canvases')}>
      <div className="canvas-card-scroll">
        {canvases.map((canvas) => {
          const canvasId = canvas.id;
          const editing = editingCanvasId === canvasId;
          return (
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
              {editing ? (
                <form
                  className="canvas-card-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    completeRename(canvas, renameFormValue(event.currentTarget));
                  }}
                >
                  <input
                    ref={editingInputRef}
                    className="db-input canvas-card-rename-input"
                    aria-label={i18n.t('canvas.cardBar.renameCanvas', { name: canvas.name })}
                    name="name"
                    defaultValue={canvas.name}
                    autoComplete="off"
                    spellCheck={false}
                    onBlur={(event) => completeRename(canvas, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelRename();
                      }
                    }}
                  />
                </form>
              ) : (
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
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    beginRename(canvasId);
                  }}
                >
                  {canvas.name}
                </Button>
              )}
              {!editing ? (
                <CloseButton
                  className="canvas-card-delete db-canvas-control"
                  label={i18n.t('canvas.cardBar.deleteCanvas', { name: canvas.name })}
                  onPointerDown={stopCanvasCardDeleteEvent}
                  onDoubleClick={stopCanvasCardDeleteEvent}
                  onClick={(event) => {
                    stopCanvasCardDeleteEvent(event);
                    void onDeleteCanvas({ canvasId });
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <IconButton className="canvas-card-add db-canvas-control" label={i18n.t('canvas.cardBar.new')} icon={<Plus size={14} />} onClick={() => { void onCreateCanvas(); }} />
    </nav>
  );
}

function renameFormValue(form: HTMLFormElement): string {
  const control = form.elements.namedItem('name') as { value?: unknown } | null;
  return typeof control?.value === 'string' ? control.value : '';
}

function stopCanvasCardDeleteEvent(event: React.SyntheticEvent): void {
  event.stopPropagation();
}
