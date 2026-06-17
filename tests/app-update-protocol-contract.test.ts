import { describe, expect, it } from 'vitest';
import type {
  DesktopAppUpdateDisabledReason,
  DesktopAppUpdateErrorOperation,
  DesktopAppUpdateInstallMode,
  DesktopAppUpdateState
} from '@debrute/app-protocol';

describe('Desktop app update protocol contract', () => {
  it('models every General page app update state', () => {
    const reasons: DesktopAppUpdateDisabledReason[] = [
      'development',
      'unpackaged',
      'browser',
      'unsupported-platform',
      'missing-update-config'
    ];
    const operations: DesktopAppUpdateErrorOperation[] = ['check', 'download', 'install'];
    const modes: DesktopAppUpdateInstallMode[] = ['automatic', 'manual-download'];
    const states: DesktopAppUpdateState[] = [
      { type: 'disabled', currentVersion: '0.2.0', reason: reasons[0] },
      {
        type: 'idle',
        currentVersion: '0.2.0',
        platform: 'darwin',
        lastCheckedAt: '2026-06-17T00:00:00.000Z',
        notAvailable: true
      },
      { type: 'checking', currentVersion: '0.2.0', explicit: true },
      {
        type: 'available',
        currentVersion: '0.2.0',
        updateVersion: '0.3.0',
        releaseName: 'Debrute 0.3.0',
        releaseDate: '2026-06-18T00:00:00.000Z',
        releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
        installMode: modes[0]
      },
      {
        type: 'available',
        currentVersion: '0.2.0',
        updateVersion: '0.3.0',
        releaseUrl: 'https://github.com/XiiTang/Debrute/releases/tag/v0.3.0',
        installMode: modes[1]
      },
      { type: 'downloading', currentVersion: '0.2.0', updateVersion: '0.3.0', percent: 42 },
      { type: 'downloaded', currentVersion: '0.2.0', updateVersion: '0.3.0', releaseName: 'Debrute 0.3.0' },
      { type: 'installing', currentVersion: '0.2.0', updateVersion: '0.3.0' },
      {
        type: 'error',
        currentVersion: '0.2.0',
        operation: operations[1],
        message: 'download failed',
        retryable: true,
        updateVersion: '0.3.0',
        installMode: 'automatic'
      }
    ];

    expect(states.map((state) => state.type)).toEqual([
      'disabled',
      'idle',
      'checking',
      'available',
      'available',
      'downloading',
      'downloaded',
      'installing',
      'error'
    ]);
  });
});
