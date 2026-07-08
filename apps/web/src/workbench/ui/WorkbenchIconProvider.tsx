import React from 'react';
import { LucideProvider } from 'lucide-react';

export function WorkbenchIconProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <LucideProvider size={16} strokeWidth={1.75} absoluteStrokeWidth>
      {children}
    </LucideProvider>
  );
}
