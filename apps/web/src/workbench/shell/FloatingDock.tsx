import React from 'react';
import {
  AlertTriangle,
  CircleDot,
  FolderTree,
  Settings,
  Terminal
} from 'lucide-react';
import {
  FLOATING_PANEL_DEFINITIONS,
  FLOATING_PANEL_IDS,
  type FloatingPanelId,
  type FloatingPanelState
} from './floatingPanels';
import { IconButton } from '../ui';

export function FloatingDock({
  panelState,
  onToggle
}: {
  panelState: FloatingPanelState;
  onToggle: (panelId: FloatingPanelId) => void;
}): React.ReactElement {
  const icons: Record<FloatingPanelId, React.ReactElement> = {
    explorer: <FolderTree size={18} />,
    inspector: <CircleDot size={18} />,
    problems: <AlertTriangle size={18} />,
    settings: <Settings size={18} />,
    terminal: <Terminal size={18} />
  };

  return (
    <nav className="db-floating-bar floating-dock" data-testid="floating-dock" aria-label="Workbench panels">
      {FLOATING_PANEL_IDS.map((panelId) => (
        <IconButton
          key={panelId}
          label={FLOATING_PANEL_DEFINITIONS[panelId].title}
          pressed={panelState.panels[panelId].open}
          icon={icons[panelId]}
          onClick={() => onToggle(panelId)}
        />
      ))}
    </nav>
  );
}
