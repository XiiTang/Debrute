import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkbenchApp } from './workbench/WorkbenchApp';
import { CanvasTextRenderProfileGate } from './workbench/canvas/CanvasTextRenderProfileContext.js';
import { DEFAULT_CANVAS_TEXT_RENDER_PROFILE } from './workbench/canvas/DefaultCanvasTextRenderProfile.js';
import './styles.css';

declare global {
  interface Window {
    __debruteReactRoot?: Root;
  }
}

window.__debruteReactRoot ??= createRoot(document.getElementById('root')!);
window.__debruteReactRoot.render(
  <CanvasTextRenderProfileGate
    profile={DEFAULT_CANVAS_TEXT_RENDER_PROFILE}
    pending={(
      <main className="boot-screen" role="status" data-testid="canvas-text-render-profile-loading">
        <span>Preparing Canvas text rendering…</span>
      </main>
    )}
  >
    <React.StrictMode>
      <WorkbenchApp />
    </React.StrictMode>
  </CanvasTextRenderProfileGate>
);
