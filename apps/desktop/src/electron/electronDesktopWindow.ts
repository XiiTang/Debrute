import electron from 'electron';
import { join } from 'node:path';

import type { DebruteProductPlatform, WorkbenchThemePreference } from '@debrute/app-protocol';

import type { DesktopHostedWindow } from './desktopWindowHost.js';
import { desktopBrowserWindowChromeOptions } from './nativeWindowShell.js';

const { BrowserWindow, nativeTheme } = electron;

export interface CreateElectronDesktopWindowInput {
  windowKey: string;
  platform: DebruteProductPlatform;
  projectIconPath: string;
  preloadDirectory: string;
  developmentOrigin: string | undefined;
  onRendererGone(reason: string): void;
}

export class ElectronDesktopWindow implements DesktopHostedWindow<Electron.BrowserWindow> {
  readonly identity: Electron.BrowserWindow;
  private readonly developmentOrigin: string | undefined;
  private destroying = false;

  constructor(input: CreateElectronDesktopWindowInput) {
    this.developmentOrigin = input.developmentOrigin;
    this.identity = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1100,
      minHeight: 720,
      show: false,
      ...desktopBrowserWindowChromeOptions(input.platform),
      icon: input.projectIconPath,
      webPreferences: {
        preload: join(input.preloadDirectory, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition: `debrute-${input.windowKey}`
      }
    });
    this.identity.webContents.on('render-process-gone', (_event, details) => {
      if (!this.destroying) {
        input.onRendererGone(details.reason);
      }
    });
  }

  isDestroyed(): boolean {
    return this.identity.isDestroyed();
  }

  show(): void {
    this.identity.show();
  }

  focus(): void {
    this.identity.focus();
  }

  applyLaunchPresentation(themePreference: WorkbenchThemePreference): void {
    this.identity.setBackgroundColor(desktopWindowBackgroundColor(
      themePreference,
      nativeTheme.shouldUseDarkColors
    ));
  }

  async load(url: string): Promise<void> {
    await this.identity.loadURL(rewriteRuntimeUrlForDevelopment(url, this.developmentOrigin));
  }

  destroy(): void {
    this.destroying = true;
    if (!this.identity.isDestroyed()) {
      this.identity.destroy();
    }
  }

  onClosed(listener: () => void): () => void {
    this.identity.once('closed', listener);
    return () => this.identity.removeListener('closed', listener);
  }
}

function desktopWindowBackgroundColor(
  themePreference: WorkbenchThemePreference,
  systemUsesDarkColors: boolean
): string {
  const dark = themePreference === 'dark'
    || (themePreference === 'system' && systemUsesDarkColors);
  return dark ? '#181818' : '#f4f5f7';
}

function rewriteRuntimeUrlForDevelopment(
  url: string,
  developmentOrigin: string | undefined
): string {
  if (!developmentOrigin) {
    return url;
  }
  const source = new URL(url);
  const target = new URL(developmentOrigin);
  target.pathname = source.pathname;
  return target.toString();
}
