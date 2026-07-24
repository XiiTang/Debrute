import React from 'react';
import { Save, X } from './WorkbenchIconProvider.js';

export function DiscardChangesIcon({ size }: { size: number }): React.ReactElement {
  return (
    <span className="db-discard-changes-icon" aria-hidden="true">
      <Save size={size} />
      <X size={Math.max(9, size - 3)} />
    </span>
  );
}
