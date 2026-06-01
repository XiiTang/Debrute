import React from 'react';
import {
  AlertTriangle,
  CircleDot,
  FolderTree,
  Settings
} from 'lucide-react';
import {
  FLOATING_PANEL_DEFINITIONS,
  FLOATING_PANEL_IDS,
  type FloatingPanelId,
  type FloatingPanelState
} from './floatingPanels';

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
    settings: <Settings size={18} />
  };

  return (
    <nav className="floating-dock" data-testid="floating-dock" aria-label="Workbench panels">
      {FLOATING_PANEL_IDS.map((panelId) => (
        <button
          key={panelId}
          type="button"
          className={panelState.panels[panelId].open ? 'active' : ''}
          title={FLOATING_PANEL_DEFINITIONS[panelId].title}
          aria-label={FLOATING_PANEL_DEFINITIONS[panelId].title}
          aria-pressed={panelState.panels[panelId].open}
          onClick={() => onToggle(panelId)}
        >
          {icons[panelId]}
        </button>
      ))}
    </nav>
  );
}
