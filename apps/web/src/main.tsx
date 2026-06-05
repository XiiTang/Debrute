import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkbenchApp } from './workbench/WorkbenchApp';
import './styles.css';

declare global {
  interface Window {
    __debruteReactRoot?: Root;
  }
}

window.__debruteReactRoot ??= createRoot(document.getElementById('root')!);
window.__debruteReactRoot.render(
  <React.StrictMode>
    <WorkbenchApp />
  </React.StrictMode>
);
