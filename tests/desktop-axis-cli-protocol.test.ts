import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AXIS_CLI_OPERATION_KINDS,
  type AxisCliDiagnostic,
  type AxisCliOperationKind,
  type AxisCliStatus,
  type DesktopEvent,
  type DesktopState,
  type DesktopWorkbenchApiClient,
  isAxisCliDiagnosticCode
} from '@axis/app-protocol';

describe('desktop Axis CLI protocol', () => {
  it('defines the managed CLI status shape used by Desktop', () => {
    const status: AxisCliStatus = {
      mode: 'release',
      managed: true,
      installedVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
      commandPath: '/Users/test/.axis/bin/axis',
      resolvedPath: '/Users/test/.axis/bin/axis',
      binDir: '/Users/test/.axis/bin',
      installRoot: '/Users/test/.axis/cli',
      pathState: 'configured'
    };

    expect(status.updateAvailable).toBe(true);
    expect(status.pathState).toBe('configured');
  });

  it('exposes only fixed operation names to the renderer', () => {
    const operations: AxisCliOperationKind[] = [...AXIS_CLI_OPERATION_KINDS];

    expect(operations).toEqual([
      'install',
      'update',
      'repair',
      'uninstall',
      'refresh-status',
      'refresh-development-link'
    ]);
  });

  it('includes setup completion and CLI change events', () => {
    const state: DesktopState = {
      recentProjectRoots: [],
      setupCompleted: false
    };
    const event: DesktopEvent = {
      type: 'desktop.axisCli.changed',
      status: {
        mode: 'missing',
        managed: false,
        updateAvailable: false,
        commandPath: '/Users/test/.axis/bin/axis',
        binDir: '/Users/test/.axis/bin',
        installRoot: '/Users/test/.axis/cli',
        pathState: 'not-configured'
      }
    };

    expect(state.setupCompleted).toBe(false);
    expect(event.type).toBe('desktop.axisCli.changed');
  });

  it('keeps CLI API methods argument-free except setup completion', () => {
    const methodNames: Array<keyof DesktopWorkbenchApiClient> = [
      'axisCliGetStatus',
      'axisCliInstall',
      'axisCliUpdate',
      'axisCliRepair',
      'axisCliUninstall',
      'axisCliRefreshDevelopmentLink',
      'setSetupCompleted'
    ];

    expect(methodNames).toHaveLength(7);
  });

  it('does not expose Desktop Skills APIs', () => {
    type DesktopApiMethod = keyof DesktopWorkbenchApiClient;
    type Forbidden = Extract<DesktopApiMethod, 'skillsListSettings' | 'skillsSync' | 'skillReadFile'>;

    expectTypeOf<Forbidden>().toEqualTypeOf<never>();
  });

  it('recognizes CLI Skills sync diagnostics', () => {
    const diagnostic: AxisCliDiagnostic = {
      code: 'skills_sync_failed',
      message: 'AXIS CLI was installed, but Skills sync failed.'
    };

    expect(isAxisCliDiagnosticCode(diagnostic.code)).toBe(true);
  });
});
