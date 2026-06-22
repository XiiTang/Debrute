import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, Maximize2, Minus, Square, X } from 'lucide-react';
import type { WorkbenchMenuId, WorkbenchMenuItem, WorkbenchTitleBarState } from '@debrute/app-protocol';
import { IconButton, Menu } from '../ui';
import {
  closeTitleBarMenu,
  openTitleBarMenu,
  switchTitleBarMenuOnHover,
  titleBarMenuKeyAction,
  type OpenTitleBarMenu
} from './workbenchTitleBarInteraction';

type WorkbenchMenuCommandItem = Extract<WorkbenchMenuItem, { kind: 'command' }>;

export interface WorkbenchTitleBarProps {
  state: WorkbenchTitleBarState;
  nativeWindowState: { maximized: boolean };
  onCommand(item: WorkbenchMenuCommandItem): void;
  onWindowCommand(command: 'minimize' | 'toggle-maximize' | 'close'): void;
}

export function WorkbenchTitleBar({
  state,
  nativeWindowState,
  onCommand,
  onWindowCommand
}: WorkbenchTitleBarProps): React.ReactElement {
  const [openMenu, setOpenMenu] = useState<OpenTitleBarMenu>();
  const [openSubmenu, setOpenSubmenu] = useState<string>();
  const rootRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRefs = useRef(new Map<WorkbenchMenuId, HTMLButtonElement>());
  const currentMenu = state.menus.find((menu) => menu.id === openMenu);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    const closeOnPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) {
        return;
      }
      setOpenMenu((current) => closeTitleBarMenu(current));
      setOpenSubmenu(undefined);
    };
    window.addEventListener('pointerdown', closeOnPointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', closeOnPointerDown, { capture: true });
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) {
      return;
    }
    setOpenSubmenu(undefined);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [openMenu]);

  const closeCurrentMenu = (restoreFocus: boolean) => {
    const menuToRestore = openMenu;
    setOpenMenu(closeTitleBarMenu(openMenu));
    setOpenSubmenu(undefined);
    if (restoreFocus) {
      restoreMenuButtonFocus(menuButtonRefs.current, menuToRestore);
    }
  };

  const handleTitleBarKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!openMenu || titleBarMenuKeyAction(event.key) !== 'close-menu') {
      return;
    }
    event.preventDefault();
    closeCurrentMenu(true);
  };

  return (
    <header
      ref={rootRef}
      className={titleBarClassName(state)}
      data-testid="workbench-titlebar"
      onKeyDown={handleTitleBarKeyDown}
    >
      <div className="workbench-titlebar__drag-region" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
      <div className="workbench-titlebar__left">
        {state.presentation.showWebMenus ? (
          <nav
            className="workbench-titlebar__menubar"
            aria-label="Application menu"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {state.menus.map((menu) => (
              <button
                key={menu.id}
                ref={(element) => setMenuButtonRef(menuButtonRefs.current, menu.id, element)}
                type="button"
                className="workbench-titlebar__menu-button"
                aria-haspopup="menu"
                aria-expanded={openMenu === menu.id}
                aria-controls={`workbench-titlebar-menu-${menu.id}`}
                onClick={() => {
                  setOpenMenu(openTitleBarMenu(openMenu, menu.id));
                  setOpenSubmenu(undefined);
                }}
                onMouseEnter={() => {
                  const nextMenu = switchTitleBarMenuOnHover(openMenu, menu.id);
                  if (nextMenu) {
                    setOpenMenu(nextMenu);
                    setOpenSubmenu(undefined);
                  }
                }}
              >
                {menu.label}
              </button>
            ))}
          </nav>
        ) : null}
      </div>
      <div className="workbench-titlebar__center">
        <div className="workbench-titlebar__title" title={state.title}>{state.title}</div>
      </div>
      <div className="workbench-titlebar__right">
        {state.presentation.showWindowControls ? (
          <div className="workbench-titlebar__window-controls" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <IconButton label="Minimize window" icon={<Minus size={13} />} onClick={() => onWindowCommand('minimize')} />
            <IconButton
              label={nativeWindowState.maximized ? 'Restore window' : 'Maximize window'}
              icon={nativeWindowState.maximized ? <Square size={12} /> : <Maximize2 size={13} />}
              onClick={() => onWindowCommand('toggle-maximize')}
            />
            <IconButton label="Close window" icon={<X size={14} />} onClick={() => onWindowCommand('close')} />
          </div>
        ) : null}
      </div>
      {currentMenu ? (
        <div className="workbench-titlebar__menu-popover" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <Menu
            id={`workbench-titlebar-menu-${currentMenu.id}`}
            ref={menuRef}
            tabIndex={-1}
            ariaLabel={`${currentMenu.label} menu`}
          >
            {currentMenu.items.map((item) => renderMenuItem(item, {
              openSubmenu,
              setOpenSubmenu,
              onCommand: (command) => {
                setOpenMenu(undefined);
                setOpenSubmenu(undefined);
                onCommand(command);
              }
            }))}
          </Menu>
        </div>
      ) : null}
    </header>
  );
}

interface RenderMenuItemOptions {
  openSubmenu: string | undefined;
  setOpenSubmenu(openSubmenu: string | undefined): void;
  onCommand: WorkbenchTitleBarProps['onCommand'];
}

function renderMenuItem(
  item: WorkbenchMenuItem,
  options: RenderMenuItemOptions
): React.ReactNode {
  if (item.kind === 'separator') {
    return <Menu.Separator key={item.id} />;
  }
  if (item.kind === 'submenu') {
    const submenuId = `workbench-titlebar-submenu-${item.id}`;
    const submenuOpen = item.enabled && options.openSubmenu === item.id;
    return (
      <div key={item.id} className="workbench-titlebar__submenu" onMouseEnter={() => {
        if (item.enabled) {
          options.setOpenSubmenu(item.id);
        }
      }}>
        <Menu.Item
          className="workbench-titlebar__submenu-trigger"
          disabled={!item.enabled}
          icon={<ChevronRight size={13} />}
          aria-haspopup="menu"
          aria-expanded={submenuOpen}
          aria-controls={submenuId}
          onClick={() => {
            if (item.enabled) {
              options.setOpenSubmenu(submenuOpen ? undefined : item.id);
            }
          }}
          onFocus={() => {
            if (item.enabled) {
              options.setOpenSubmenu(item.id);
            }
          }}
          onKeyDown={(event) => {
            const action = titleBarMenuKeyAction(event.key);
            if (action === 'open-submenu' && item.enabled) {
              event.preventDefault();
              options.setOpenSubmenu(item.id);
            }
            if (action === 'close-submenu') {
              event.preventDefault();
              options.setOpenSubmenu(undefined);
            }
          }}
        >
          {item.label}
        </Menu.Item>
        {submenuOpen ? (
          <Menu
            id={submenuId}
            className="workbench-titlebar__submenu-menu"
            ariaLabel={`${item.label} submenu`}
            onKeyDown={(event) => {
              if (titleBarMenuKeyAction(event.key) !== 'close-submenu') {
                return;
              }
              event.preventDefault();
              options.setOpenSubmenu(undefined);
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>('.workbench-titlebar__submenu-trigger')
                ?.focus();
            }}
          >
            {item.items.map((subItem) => renderMenuItem(subItem, options))}
          </Menu>
        ) : null}
      </div>
    );
  }
  return (
    <Menu.Item
      key={item.id}
      disabled={!item.enabled}
      onMouseEnter={() => options.setOpenSubmenu(undefined)}
      onClick={() => {
        if (item.enabled) {
          options.onCommand(item);
        }
      }}
    >
      {item.label}
    </Menu.Item>
  );
}

function titleBarClassName(state: WorkbenchTitleBarState): string {
  return [
    'workbench-titlebar',
    state.presentation.trafficLightSpacer ? 'workbench-titlebar--traffic-spacer' : ''
  ].filter(Boolean).join(' ');
}

function setMenuButtonRef(
  menuButtons: Map<WorkbenchMenuId, HTMLButtonElement>,
  menuId: WorkbenchMenuId,
  element: HTMLButtonElement | null
): void {
  if (element) {
    menuButtons.set(menuId, element);
  } else {
    menuButtons.delete(menuId);
  }
}

function restoreMenuButtonFocus(
  menuButtons: ReadonlyMap<WorkbenchMenuId, HTMLButtonElement>,
  menuId: OpenTitleBarMenu
): void {
  if (menuId) {
    menuButtons.get(menuId)?.focus();
  }
}
