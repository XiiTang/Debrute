import { EventEmitter } from 'node:events';
import type {
  DesktopAppUpdateDisabledReason,
  DesktopAppUpdateErrorOperation,
  DesktopAppUpdateInstallMode,
  DesktopAppUpdateState
} from '@debrute/app-protocol';
import {
  appUpdateDisabledState,
  appUpdateErrorState,
  appUpdateIdleState,
  appUpdateStateFromInfo,
  normalizeDownloadPercent,
  type AppUpdateInfoLike
} from './appUpdateState.js';

export interface DesktopAppUpdateDriver {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<{ updateInfo?: AppUpdateInfoLike | null } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'download-progress', listener: (progress: { percent?: number }) => void): this;
  on(event: 'update-downloaded', listener: (info: AppUpdateInfoLike) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface LinuxAppUpdateRelease {
  version: string;
  releaseName?: string;
  releaseDate?: string;
  releaseUrl: string;
}

export interface DesktopAppUpdateService {
  getState(): DesktopAppUpdateState;
  checkForUpdates(explicit: boolean): Promise<DesktopAppUpdateState>;
  downloadUpdate(): Promise<DesktopAppUpdateState>;
  installDownloadedUpdate(): Promise<DesktopAppUpdateState>;
  openManualDownloadPage(): Promise<{ ok: true }>;
  onStateChange(listener: (state: DesktopAppUpdateState) => void): () => void;
  startDelayedBackgroundCheck(delayMs?: number): void;
}

export interface DesktopAppUpdateServiceInput {
  app: {
    isPackaged: boolean;
    getVersion(): string;
  };
  platform: NodeJS.Platform;
  driver: DesktopAppUpdateDriver;
  linuxReleaseChecker: () => Promise<LinuxAppUpdateRelease | null>;
  openExternal?: (url: string) => Promise<unknown>;
  now?: () => string;
  setTimeout?: (handler: () => void, delayMs: number) => unknown;
}

export function createDesktopAppUpdateService(input: DesktopAppUpdateServiceInput): DesktopAppUpdateService {
  const currentVersion = input.app.getVersion();
  const now = input.now ?? (() => new Date().toISOString());
  const events = new EventEmitter();
  const disabledReason = disabledReasonFor(input.app.isPackaged, input.platform);
  let state: DesktopAppUpdateState = disabledReason
    ? appUpdateDisabledState({ currentVersion, platform: input.platform, reason: disabledReason })
    : appUpdateIdleState({ currentVersion, platform: input.platform });

  input.driver.autoDownload = false;
  input.driver.autoInstallOnAppQuit = false;

  input.driver.on('download-progress', (progress) => {
    const updateVersion = updateVersionFromState(state);
    if (!updateVersion) {
      return;
    }
    setState({
      type: 'downloading',
      currentVersion,
      platform: input.platform,
      updateVersion,
      percent: normalizeDownloadPercent(progress.percent ?? 0)
    });
  });
  input.driver.on('update-downloaded', (info) => {
    setState({
      type: 'downloaded',
      currentVersion,
      platform: input.platform,
      updateVersion: info.version,
      ...(info.releaseName ? { releaseName: info.releaseName } : {}),
      ...(info.releaseDate ? { releaseDate: info.releaseDate } : {})
    });
  });
  input.driver.on('error', (error) => {
    const previousUpdateVersion = updateVersionFromState(state);
    const previousInstallMode = installModeFromState(state);
    setState(appUpdateErrorState({
      currentVersion,
      platform: input.platform,
      operation: errorOperationFromState(state),
      error,
      ...(previousUpdateVersion ? { updateVersion: previousUpdateVersion } : {}),
      ...(previousInstallMode ? { installMode: previousInstallMode } : {})
    }));
  });

  function setState(next: DesktopAppUpdateState): DesktopAppUpdateState {
    state = next;
    events.emit('change', state);
    return state;
  }

  async function checkForUpdates(explicit: boolean): Promise<DesktopAppUpdateState> {
    if (state.type === 'disabled') {
      return state;
    }
    setState({ type: 'checking', currentVersion, platform: input.platform, explicit });
    if (input.platform === 'linux') {
      return checkLinuxRelease();
    }
    try {
      const result = await input.driver.checkForUpdates();
      const updateInfo = result?.updateInfo ?? null;
      if (!updateInfo || !isVersionGreater(updateInfo.version, currentVersion)) {
        return setState(appUpdateIdleState({
          currentVersion,
          platform: input.platform,
          now,
          notAvailable: true
        }));
      }
      return setState(appUpdateStateFromInfo({
        currentVersion,
        platform: input.platform,
        info: updateInfo,
        installMode: 'automatic'
      }));
    } catch (error) {
      return setState(appUpdateErrorState({
        currentVersion,
        platform: input.platform,
        operation: 'check',
        error
      }));
    }
  }

  async function checkLinuxRelease(): Promise<DesktopAppUpdateState> {
    try {
      const release = await input.linuxReleaseChecker();
      if (!release || !isVersionGreater(release.version, currentVersion)) {
        return setState(appUpdateIdleState({
          currentVersion,
          platform: input.platform,
          now,
          notAvailable: true
        }));
      }
      return setState(appUpdateStateFromInfo({
        currentVersion,
        platform: input.platform,
        info: release,
        releaseUrl: release.releaseUrl,
        installMode: 'manual-download'
      }));
    } catch (error) {
      return setState(appUpdateErrorState({
        currentVersion,
        platform: input.platform,
        operation: 'check',
        error
      }));
    }
  }

  return {
    getState: () => state,
    checkForUpdates,
    downloadUpdate: async () => {
      if (state.type !== 'available' && !(state.type === 'error' && state.operation === 'download' && state.updateVersion)) {
        return state;
      }
      const updateVersion = updateVersionFromState(state);
      const installMode = 'installMode' in state ? state.installMode : undefined;
      if (!updateVersion || installMode !== 'automatic') {
        return state;
      }
      setState({ type: 'downloading', currentVersion, platform: input.platform, updateVersion, percent: 0 });
      try {
        await input.driver.downloadUpdate();
        return state;
      } catch (error) {
        return setState(appUpdateErrorState({
          currentVersion,
          platform: input.platform,
          operation: 'download',
          error,
          updateVersion,
          installMode
        }));
      }
    },
    installDownloadedUpdate: async () => {
      if (state.type !== 'downloaded' && !(state.type === 'error' && state.operation === 'install' && state.updateVersion)) {
        return state;
      }
      const updateVersion = updateVersionFromState(state);
      if (!updateVersion) {
        return state;
      }
      setState({ type: 'installing', currentVersion, platform: input.platform, updateVersion });
      try {
        input.driver.quitAndInstall(true, true);
        return state;
      } catch (error) {
        return setState(appUpdateErrorState({
          currentVersion,
          platform: input.platform,
          operation: 'install',
          error,
          updateVersion,
          installMode: 'automatic'
        }));
      }
    },
    openManualDownloadPage: async () => {
      if (state.type === 'available' && state.installMode === 'manual-download' && state.releaseUrl) {
        await input.openExternal?.(state.releaseUrl);
      }
      return { ok: true };
    },
    onStateChange: (listener) => {
      events.on('change', listener);
      return () => events.off('change', listener);
    },
    startDelayedBackgroundCheck: (delayMs = 2000) => {
      if (state.type === 'disabled') {
        return;
      }
      const setTimeoutImpl = input.setTimeout ?? setTimeout;
      setTimeoutImpl(() => {
        void checkForUpdates(false);
      }, delayMs);
    }
  };
}

export function latestDebruteReleaseFromGitHubResponse(value: unknown): LinuxAppUpdateRelease | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true) {
    return null;
  }
  if (typeof record.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(record.tag_name)) {
    return null;
  }
  if (typeof record.html_url !== 'string') {
    return null;
  }
  return {
    version: record.tag_name.slice(1),
    ...(typeof record.name === 'string' ? { releaseName: record.name } : {}),
    ...(typeof record.published_at === 'string' ? { releaseDate: record.published_at } : {}),
    releaseUrl: record.html_url
  };
}

export async function fetchLatestDebruteRelease(input: {
  fetch: typeof fetch;
}): Promise<LinuxAppUpdateRelease | null> {
  const response = await input.fetch('https://api.github.com/repos/XiiTang/Debrute/releases/latest', {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'Debrute Desktop'
    }
  });
  if (!response.ok) {
    throw new Error(`GitHub latest release check failed: ${response.status}`);
  }
  return latestDebruteReleaseFromGitHubResponse(await response.json());
}

function disabledReasonFor(
  isPackaged: boolean,
  platform: NodeJS.Platform
): DesktopAppUpdateDisabledReason | undefined {
  if (!isPackaged) {
    return 'development';
  }
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    return 'unsupported-platform';
  }
  return undefined;
}

function updateVersionFromState(state: DesktopAppUpdateState): string | undefined {
  return 'updateVersion' in state ? state.updateVersion : undefined;
}

function installModeFromState(state: DesktopAppUpdateState): DesktopAppUpdateInstallMode | undefined {
  if ('installMode' in state) {
    return state.installMode;
  }
  if (state.type === 'downloaded' || state.type === 'installing') {
    return 'automatic';
  }
  return undefined;
}

function errorOperationFromState(state: DesktopAppUpdateState): DesktopAppUpdateErrorOperation {
  if (state.type === 'downloading') {
    return 'download';
  }
  if (state.type === 'installing') {
    return 'install';
  }
  return 'check';
}

function isVersionGreater(candidate: string, current: string): boolean {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  if (!candidateParts || !currentParts) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (candidateParts[index] > currentParts[index]) {
      return true;
    }
    if (candidateParts[index] < currentParts[index]) {
      return false;
    }
  }
  return false;
}

function versionParts(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
