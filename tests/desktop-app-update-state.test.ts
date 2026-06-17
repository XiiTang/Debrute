import { describe, expect, it } from 'vitest';
import {
  appUpdateDisabledState,
  appUpdateErrorState,
  appUpdateIdleState,
  appUpdateStateFromInfo,
  normalizeDownloadPercent
} from '../apps/desktop/src/electron/app-update/appUpdateState';

describe('desktop app update state helpers', () => {
  it('creates disabled and idle states with current version', () => {
    expect(appUpdateDisabledState('0.2.0', 'development')).toEqual({
      type: 'disabled',
      currentVersion: '0.2.0',
      reason: 'development'
    });
    expect(appUpdateIdleState({
      currentVersion: '0.2.0',
      platform: 'darwin',
      now: () => '2026-06-17T00:00:00.000Z',
      notAvailable: true
    })).toEqual({
      type: 'idle',
      currentVersion: '0.2.0',
      platform: 'darwin',
      lastCheckedAt: '2026-06-17T00:00:00.000Z',
      notAvailable: true
    });
  });

  it('maps update info to automatic and manual-download availability', () => {
    expect(appUpdateStateFromInfo({
      currentVersion: '0.2.0',
      installMode: 'automatic',
      info: {
        version: '0.3.0',
        releaseName: 'Debrute 0.3.0',
        releaseDate: '2026-06-18T00:00:00.000Z'
      }
    })).toEqual({
      type: 'available',
      currentVersion: '0.2.0',
      updateVersion: '0.3.0',
      releaseName: 'Debrute 0.3.0',
      releaseDate: '2026-06-18T00:00:00.000Z',
      installMode: 'automatic'
    });

    expect(appUpdateStateFromInfo({
      currentVersion: '0.2.0',
      installMode: 'manual-download',
      releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      info: { version: '0.3.0' }
    })).toMatchObject({
      type: 'available',
      updateVersion: '0.3.0',
      releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
      installMode: 'manual-download'
    });
  });

  it('normalizes progress', () => {
    expect(normalizeDownloadPercent(-20)).toBe(0);
    expect(normalizeDownloadPercent(42.4)).toBe(42);
    expect(normalizeDownloadPercent(250)).toBe(100);
  });

  it('keeps retry context in error states', () => {
    expect(appUpdateErrorState({
      currentVersion: '0.2.0',
      operation: 'download',
      error: new Error('network failed'),
      updateVersion: '0.3.0',
      installMode: 'automatic'
    })).toEqual({
      type: 'error',
      currentVersion: '0.2.0',
      operation: 'download',
      message: 'network failed',
      retryable: true,
      updateVersion: '0.3.0',
      installMode: 'automatic'
    });
  });
});
