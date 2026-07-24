import React, { useEffect, useMemo, useRef } from 'react';
import type { DebruteProductPlatform } from '@debrute/app-protocol';
import {
  Clipboard,
  Copy,
  Edit3,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  Info,
  LocateFixed,
  RotateCcw,
  Send,
  Scissors,
  Trash2
} from 'lucide-react';
import {
  clampWorkbenchContextMenuPosition,
  type ProjectPathCommand,
  type WorkbenchContextMenuItem,
  type WorkbenchContextMenuPosition
} from './contextMenu';
import { Menu } from '../ui';
import { useI18n } from '../i18n';
import {
  projectSystemFileManagerLabelForLocale,
  workbenchContextMenuCommandLabel
} from './contextMenuI18n';

const CONTEXT_MENU_WIDTH = 190;
const CONTEXT_MENU_ROW_HEIGHT = 32;
const CONTEXT_MENU_VERTICAL_PADDING = 10;

export function WorkbenchContextMenu({
  items,
  position,
  onCommand,
  onClose,
  productPlatform
}: {
  items: WorkbenchContextMenuItem[];
  position: WorkbenchContextMenuPosition;
  onCommand: (command: ProjectPathCommand) => void;
  onClose: () => void;
  productPlatform: DebruteProductPlatform;
}): React.ReactElement | null {
  const i18n = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const actionCount = items.filter((item) => item.kind === 'action').length;
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

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, []);

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }
      onClose();
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const closeOnWheel = () => onClose();
    const closeOnScroll = () => onClose();
    window.addEventListener('pointerdown', closeOnPointerDown, { capture: true });
    window.addEventListener('keydown', closeOnKeyDown);
    window.addEventListener('wheel', closeOnWheel, { capture: true });
    window.addEventListener('scroll', closeOnScroll, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', closeOnPointerDown, { capture: true });
      window.removeEventListener('keydown', closeOnKeyDown);
      window.removeEventListener('wheel', closeOnWheel, { capture: true });
      window.removeEventListener('scroll', closeOnScroll, { capture: true });
    };
  }, [onClose]);

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
        ) : (
          <Menu.Item
            key={item.command}
            disabled={item.disabled === true}
            variant={item.command === 'delete' || item.command === 'delete-permanently' ? 'danger' : 'default'}
            icon={contextMenuIcon(item.command)}
            onClick={() => {
              if (item.disabled === true) {
                return;
              }
              onCommand(item.command);
            }}
          >
            {item.command === 'reveal-in-system-file-manager'
              ? projectSystemFileManagerLabelForLocale(productPlatform, i18n)
              : workbenchContextMenuCommandLabel(item.command, i18n)}
          </Menu.Item>
        )
      ))}
    </Menu>
  );
}

function contextMenuIcon(command: ProjectPathCommand): React.ReactElement {
  if (command === 'show-details') {
    return <Info size={14} />;
  }
  if (command === 'reveal-in-canvas') {
    return <LocateFixed size={14} />;
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
  if (command === 'reveal-in-system-file-manager') {
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
