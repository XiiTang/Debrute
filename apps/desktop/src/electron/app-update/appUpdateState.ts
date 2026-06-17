import type {
  DesktopAppUpdateDisabledReason,
  DesktopAppUpdateErrorOperation,
  DesktopAppUpdateInstallMode,
  DesktopAppUpdateState
} from '@debrute/app-protocol';

export interface AppUpdateInfoLike {
  version: string;
  releaseName?: string;
  releaseDate?: string;
}

export function appUpdateDisabledState(
  currentVersion: string,
  reason: DesktopAppUpdateDisabledReason
): DesktopAppUpdateState {
  return { type: 'disabled', currentVersion, reason };
}

export function appUpdateIdleState(input: {
  currentVersion: string;
  platform: NodeJS.Platform;
  now?: () => string;
  notAvailable?: boolean;
  lastError?: string;
}): DesktopAppUpdateState {
  return {
    type: 'idle',
    currentVersion: input.currentVersion,
    platform: input.platform,
    ...(input.now ? { lastCheckedAt: input.now() } : {}),
    ...(input.notAvailable === true ? { notAvailable: true } : {}),
    ...(input.lastError ? { lastError: input.lastError } : {})
  };
}

export function appUpdateStateFromInfo(input: {
  currentVersion: string;
  info: AppUpdateInfoLike;
  installMode: DesktopAppUpdateInstallMode;
  releaseUrl?: string;
}): DesktopAppUpdateState {
  return {
    type: 'available',
    currentVersion: input.currentVersion,
    updateVersion: input.info.version,
    ...(input.info.releaseName ? { releaseName: input.info.releaseName } : {}),
    ...(input.info.releaseDate ? { releaseDate: input.info.releaseDate } : {}),
    ...(input.releaseUrl ? { releaseUrl: input.releaseUrl } : {}),
    installMode: input.installMode
  };
}

export function appUpdateErrorState(input: {
  currentVersion: string;
  operation: DesktopAppUpdateErrorOperation;
  error: unknown;
  retryable?: boolean;
  updateVersion?: string;
  installMode?: DesktopAppUpdateInstallMode;
}): DesktopAppUpdateState {
  return {
    type: 'error',
    currentVersion: input.currentVersion,
    operation: input.operation,
    message: errorMessage(input.error),
    retryable: input.retryable ?? true,
    ...(input.updateVersion ? { updateVersion: input.updateVersion } : {}),
    ...(input.installMode ? { installMode: input.installMode } : {})
  };
}

export function normalizeDownloadPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
