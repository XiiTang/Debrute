import type { EventEmitter } from 'node:events';
import type { DesktopUpdateState } from '@axis/app-protocol';

export interface DesktopUpdateInfo {
  version: string;
  releaseName?: string | null;
  releaseDate?: string | null;
}

export interface DesktopUpdateCheckResult {
  updateInfo: DesktopUpdateInfo;
  isUpdateAvailable?: boolean;
}

export interface DesktopUpdaterAdapter extends Pick<EventEmitter, 'on'> {
  autoDownload: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<DesktopUpdateCheckResult | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface DesktopUpdateService {
  getState(): DesktopUpdateState;
  onStateChange(listener: (state: DesktopUpdateState) => void): () => void;
  checkForUpdates(explicit: boolean): Promise<DesktopUpdateState>;
  updateNow(): Promise<DesktopUpdateState>;
}

export interface CreateDesktopUpdateServiceOptions<HotExitSnapshot> {
  currentVersion: string;
  packaged: boolean;
  platform: NodeJS.Platform;
  updater: DesktopUpdaterAdapter;
  requestHotExitSnapshot: () => Promise<HotExitSnapshot>;
  writeHotExitSnapshot: (snapshot: HotExitSnapshot) => Promise<void>;
  now?: () => string;
}

type StateListener = (state: DesktopUpdateState) => void;

export function createDesktopUpdateService<HotExitSnapshot>(
  options: CreateDesktopUpdateServiceOptions<HotExitSnapshot>
): DesktopUpdateService {
  return new DefaultDesktopUpdateService(options);
}

class DefaultDesktopUpdateService<HotExitSnapshot> implements DesktopUpdateService {
  private state: DesktopUpdateState;
  private readonly listeners = new Set<StateListener>();
  private availableUpdate: DesktopUpdateInfo | undefined;

  constructor(private readonly options: CreateDesktopUpdateServiceOptions<HotExitSnapshot>) {
    this.state = initialState(options);
    options.updater.autoDownload = false;
    options.updater.allowPrerelease = false;
    options.updater.on('download-progress', (progress: { percent?: number }) => {
      if (this.state.type === 'downloading') {
        this.setState({
          ...this.state,
          ...(typeof progress.percent === 'number' ? { percent: progress.percent } : {})
        });
      }
    });
    options.updater.on('error', (error: unknown) => {
      this.setIdle({ lastError: errorMessage(error) });
    });
  }

  getState(): DesktopUpdateState {
    return this.state;
  }

  onStateChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async checkForUpdates(explicit: boolean): Promise<DesktopUpdateState> {
    if (this.state.type === 'disabled') {
      return this.state;
    }
    if (this.state.type === 'checking' || this.state.type === 'downloading' || this.state.type === 'installing') {
      return this.state;
    }

    this.setState({ type: 'checking', currentVersion: this.options.currentVersion, explicit });
    try {
      const result = await this.options.updater.checkForUpdates();
      const update = result?.updateInfo;
      if (!update || result?.isUpdateAvailable === false || update.version === this.options.currentVersion) {
        this.availableUpdate = undefined;
        this.setIdle(explicit ? { notAvailable: true } : {});
        return this.state;
      }
      this.availableUpdate = update;
      this.setState(availableState(this.options.currentVersion, update));
      return this.state;
    } catch (error) {
      this.availableUpdate = undefined;
      this.setIdle({ lastError: errorMessage(error) });
      return this.state;
    }
  }

  async updateNow(): Promise<DesktopUpdateState> {
    if (this.state.type === 'disabled' || this.state.type === 'downloading' || this.state.type === 'installing' || this.state.type === 'checking') {
      return this.state;
    }

    if (!this.availableUpdate) {
      await this.checkForUpdates(true);
    }
    if (!this.availableUpdate) {
      return this.state;
    }

    const update = this.availableUpdate;
    this.setState({ type: 'downloading', currentVersion: this.options.currentVersion, updateVersion: update.version });
    try {
      await this.options.updater.downloadUpdate();
      const snapshot = await this.options.requestHotExitSnapshot();
      await this.options.writeHotExitSnapshot(snapshot);
      this.setState({ type: 'installing', currentVersion: this.options.currentVersion, updateVersion: update.version });
      this.options.updater.quitAndInstall(true, true);
      return this.state;
    } catch (error) {
      this.setState({
        ...availableState(this.options.currentVersion, update),
        lastError: errorMessage(error)
      });
      return this.state;
    }
  }

  private setIdle(extra: { notAvailable?: boolean; lastError?: string } = {}): void {
    this.setState({
      type: 'idle',
      currentVersion: this.options.currentVersion,
      lastCheckedAt: this.options.now?.() ?? new Date().toISOString(),
      ...extra
    });
  }

  private setState(state: DesktopUpdateState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

function initialState(options: { packaged: boolean; platform: NodeJS.Platform; currentVersion: string }): DesktopUpdateState {
  if (!options.packaged) {
    return { type: 'disabled', reason: 'development' };
  }
  if (options.platform !== 'darwin' && options.platform !== 'win32') {
    return { type: 'disabled', reason: 'unsupported-platform' };
  }
  return { type: 'idle', currentVersion: options.currentVersion };
}

function availableState(currentVersion: string, update: DesktopUpdateInfo): Extract<DesktopUpdateState, { type: 'available' }> {
  return {
    type: 'available',
    currentVersion,
    updateVersion: update.version,
    ...(update.releaseName ? { releaseName: update.releaseName } : {}),
    ...(update.releaseDate ? { releaseDate: update.releaseDate } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
