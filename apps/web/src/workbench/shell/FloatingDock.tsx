import React from 'react';
import {
  CircleDot,
  FolderTree,
  Settings,
  Terminal
} from 'lucide-react';
import {
  FLOATING_PANEL_IDS,
  type FloatingPanelId,
  type FloatingPanelState
} from './floatingPanels';
import { IconButton } from '../ui';
import { useI18n, type WorkbenchTranslationKey } from '../i18n';

const floatingPanelTitleKeys: Record<FloatingPanelId, WorkbenchTranslationKey> = {
  explorer: 'shell.panels.explorer',
  inspector: 'shell.panels.inspector',
  settings: 'shell.panels.settings',
  terminal: 'shell.panels.terminal'
};

export function FloatingDock({
  panelState,
  disabledPanelIds = [],
  onToggle
}: {
  panelState: FloatingPanelState;
  disabledPanelIds?: readonly FloatingPanelId[];
  onToggle: (panelId: FloatingPanelId) => void;
}): React.ReactElement {
  const i18n = useI18n();
  const disabledPanels = new Set(disabledPanelIds);
  const icons: Record<FloatingPanelId, React.ReactElement> = {
    explorer: <FolderTree />,
    inspector: <CircleDot />,
    settings: <Settings />,
    terminal: <Terminal />
  };

  return (
    <nav className="floating-dock" data-testid="floating-dock" aria-label={i18n.t('shell.panels.workbenchPanels')}>
      {FLOATING_PANEL_IDS.map((panelId) => (
        <IconButton
          key={panelId}
          label={i18n.t(floatingPanelTitleKeys[panelId])}
          pressed={panelState.panels[panelId].open}
          icon={icons[panelId]}
          disabled={disabledPanels.has(panelId)}
          onClick={() => onToggle(panelId)}
        />
      ))}
    </nav>
  );
}
