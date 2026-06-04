import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WorkbenchApp } from './workbench/WorkbenchApp';
import './styles.css';

declare global {
  interface Window {
    __axisReactRoot?: Root;
  }
}

window.__axisReactRoot ??= createRoot(document.getElementById('root')!);
window.__axisReactRoot.render(
  <React.StrictMode>
    <WorkbenchApp />
  </React.StrictMode>
);
