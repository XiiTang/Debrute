import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import {
  Clipboard,
  ChevronRight,
  Copy,
  Edit3,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Info,
  RotateCcw,
  Send,
  Scissors,
  Trash2
} from '../ui/index';
import {
  clampWorkbenchContextMenuPosition,
  type ProjectPathCommand,
  type PhotoshopDocumentTarget,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuPosition
} from './contextMenu';
import { Menu } from '../ui/index';
import { useI18n } from '../i18n';
import {
  projectSystemFileManagerLabelForLocale,
  workbenchContextMenuCommandLabel
} from './contextMenuI18n';

const CONTEXT_MENU_WIDTH = 190;
const CONTEXT_MENU_ROW_HEIGHT = 32;
const CONTEXT_MENU_VERTICAL_PADDING = 10;

export function PendingWorkbenchContextMenuDismissal({
  onClose
}: {
  onClose(): void;
}): null {
  useEffect(() => {
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const close = () => onClose();
    window.addEventListener('pointerdown', close, { capture: true });
    window.addEventListener('keydown', closeOnKeyDown);
    window.addEventListener('wheel', close, { capture: true });
    window.addEventListener('scroll', close, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', close, { capture: true });
      window.removeEventListener('keydown', closeOnKeyDown);
      window.removeEventListener('wheel', close, { capture: true });
      window.removeEventListener('scroll', close, { capture: true });
    };
  }, [onClose]);
  return null;
}

export function WorkbenchContextMenu({
  items,
  position,
  onCommand,
  onClose,
  onReturnFocus,
  productPlatform,
  selectionCount = 1
}: {
  items: WorkbenchContextMenuItem[];
  position: WorkbenchContextMenuPosition;
  onCommand: (command: ProjectPathCommand, target?: PhotoshopDocumentTarget) => void;
  onClose: () => void;
  onReturnFocus: () => void;
  productPlatform: DebruteProductPlatform;
  selectionCount?: number;
}): React.ReactElement | null {
  const i18n = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef(onReturnFocus);
  returnFocusRef.current = onReturnFocus;
  const actionCount = items.filter((item) => item.kind !== 'separator').length;
  const separatorCount = items.filter((item) => item.kind === 'separator').length;
  const clampedPosition = useMemo(() => clampWorkbenchContextMenuPosition({
    position,
    menuSize: {
      width: CONTEXT_MENU_WIDTH,
      height: CONTEXT_MENU_VERTICAL_PADDING + actionCount * CONTEXT_MENU_ROW_HEIGHT + separatorCount * 9
    },
    viewportSize: {
      width: window.innerWidth,
      height: window.innerHeight
    }
  }), [actionCount, separatorCount, position]);

  const completeFocusBorrow = useCallback((action: () => void) => {
    const menu = menuRef.current;
    const focusWasBorrowed = Boolean(menu?.contains(document.activeElement));
    action();
    if (!focusWasBorrowed) {
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body || menu?.contains(active)) {
      returnFocusRef.current?.();
    }
  }, []);

  useLayoutEffect(() => () => {
    if (menuRef.current?.contains(document.activeElement)) {
      returnFocusRef.current?.();
    }
  }, []);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [items]);

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      completeFocusBorrow(onClose);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        completeFocusBorrow(onClose);
      }
    };
    const closeOnWheel = () => completeFocusBorrow(onClose);
    const closeOnScroll = () => completeFocusBorrow(onClose);
    window.addEventListener('pointerdown', closeOnPointerDown, { capture: true });
    window.addEventListener('keydown', closeOnKeyDown, { capture: true });
    window.addEventListener('wheel', closeOnWheel, { capture: true });
    window.addEventListener('scroll', closeOnScroll, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, { capture: true });
      window.removeEventListener('keydown', closeOnKeyDown, { capture: true });
      window.removeEventListener('wheel', closeOnWheel, { capture: true });
      window.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [completeFocusBorrow, onClose]);

  if (items.length === 0) {
    return null;
  }

  return (
    <Menu
      ref={menuRef}
      className="workbench-context-menu"
      ariaLabel={i18n.t('shell.contextMenu.ariaLabel')}
      style={{
        left: clampedPosition.x,
        top: clampedPosition.y,
        width: CONTEXT_MENU_WIDTH
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        item.kind === 'separator' ? (
          <Menu.Separator key={item.id} />
        ) : item.kind === 'photoshop-submenu' ? (
          <PhotoshopSubmenu
            key={item.command}
            targets={item.targets}
            opensLeft={clampedPosition.x + CONTEXT_MENU_WIDTH * 2 > window.innerWidth}
            onCommand={(target) => completeFocusBorrow(() => onCommand(item.command, target))}
          />
        ) : (
          <Menu.Item
            key={item.command}
            disabled={item.disabled === true}
            variant={item.command === 'delete' || item.command === 'delete-permanently' ? 'danger' : 'default'}
            start={contextMenuIcon(item.command)}
            onClick={() => {
              if (item.disabled === true) {
                return;
              }
              completeFocusBorrow(() => onCommand(item.command));
            }}
          >
            {item.command === 'reveal-in-system-file-manager'
              ? projectSystemFileManagerLabelForLocale(productPlatform, i18n)
              : workbenchContextMenuCommandLabel(item.command, i18n, selectionCount)}
          </Menu.Item>
        )
      ))}
    </Menu>
  );
}

function PhotoshopSubmenu({
  targets,
  opensLeft,
  onCommand
}: {
  targets: PhotoshopDocumentTarget[];
  opensLeft: boolean;
  onCommand(target: PhotoshopDocumentTarget): void;
}): React.ReactElement {
  const i18n = useI18n();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const submenuRef = useRef<HTMLDivElement | null>(null);
  const focusFirstTarget = () => {
    submenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  };
  return (
    <div className="workbench-context-submenu">
      <Menu.Item
        ref={triggerRef}
        aria-haspopup="menu"
        start={<Send size={14} />}
        end={<ChevronRight size={12} />}
        onClick={focusFirstTarget}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            focusFirstTarget();
          }
        }}
      >
        {workbenchContextMenuCommandLabel('send-to-photoshop', i18n)}
      </Menu.Item>
      <Menu
        ref={submenuRef}
        className={opensLeft
          ? 'workbench-context-submenu__menu workbench-context-submenu__menu--left'
          : 'workbench-context-submenu__menu'}
        ariaLabel={i18n.t('shell.contextMenu.photoshopDocuments')}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            triggerRef.current?.focus();
          }
        }}
      >
        {targets.length === 0 ? (
          <Menu.Item disabled>{i18n.t('shell.contextMenu.noPhotoshopDocuments')}</Menu.Item>
        ) : targets.map((target) => (
          <Menu.Item
            key={`${target.pluginSessionId}:${target.documentId}`}
            title={target.title}
            className={target.requirement === undefined ? undefined : 'workbench-context-submenu__target'}
            disabled={target.disabled === true}
            onClick={() => {
              if (target.disabled === true) return;
              onCommand(target);
            }}
          >
            <span className="workbench-context-submenu__target-title">{target.title}</span>
            {target.requirement === 'photoshop_26_8_for_avif' ? (
              <span className="workbench-context-submenu__target-requirement">
                {i18n.t('shell.contextMenu.photoshopRequiresAvif26_8')}
              </span>
            ) : null}
          </Menu.Item>
        ))}
      </Menu>
    </div>
  );
}

function contextMenuIcon(command: ProjectPathCommand): React.ReactElement {
  if (command === 'inspect') {
    return <Info size={14} />;
  }
  if (command === 'reset-auto-layout') {
    return <RotateCcw size={14} />;
  }
  if (command === 'send-to-photoshop') {
    return <Send size={14} />;
  }
  if (command === 'create-file') {
    return <FilePlus2 size={14} />;
  }
  if (command === 'create-directory') {
    return <FolderPlus size={14} />;
  }
  if (command === 'cut') {
    return <Scissors size={14} />;
  }
  if (command === 'paste') {
    return <Clipboard size={14} />;
  }
  if (command === 'reveal-in-canvas' || command === 'reveal-in-system-file-manager') {
    return <FolderOpen size={14} />;
  }
  if (command === 'rename') {
    return <Edit3 size={14} />;
  }
  if (command === 'delete' || command === 'delete-permanently') {
    return <Trash2 size={14} />;
  }
  return <Copy size={14} />;
}
