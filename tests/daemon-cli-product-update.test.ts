import { describe, expect, it, vi } from 'vitest';
import type { DebruteAppServer } from '@debrute/app-server';
import { runDaemonCliCommand } from '../apps/daemon/src/http/cliCommandRoutes';

describe('daemon CLI product commands', () => {
  it('runs update through the runtime product update service', async () => {
    const productUpdate = {
      state: vi.fn(),
      check: vi.fn(),
      apply: vi.fn(async () => ({
        state: {
          productVersion: '0.2.0',
          platform: process.platform,
          cli: {
            status: 'ready' as const,
            version: '0.2.0',
            path: '/Users/me/.debrute/bin/debrute',
            skillsVersion: '0.2.0',
            skillsRoot: '/Users/me/.agents/skills'
          },
          update: {
            type: 'installing' as const,
            currentVersion: '0.2.0',
            updateVersion: '0.3.0'
          }
        }
      }))
    };

    await expect(runDaemonCliCommand({
      command: 'update',
      positional: [],
      options: {}
    }, {
      server: {} as DebruteAppServer,
      productServices: {
        managedCli: {
          ensureCurrent: vi.fn(),
          diagnostic: vi.fn()
        },
        productUpdate
      }
    })).resolves.toEqual({
      status: 'ok',
      command: 'update',
      fields: {
        current_version: '0.2.0',
        update_state: 'installing',
        update_version: '0.3.0'
      }
    });
    expect(productUpdate.apply).toHaveBeenCalledTimes(1);
  });

  it('reports runtime product update apply errors as failed CLI results', async () => {
    const productUpdate = {
      state: vi.fn(),
      check: vi.fn(),
      apply: vi.fn(async () => ({
        state: {
          productVersion: '0.2.0',
          platform: process.platform,
          cli: {
            status: 'ready' as const,
            version: '0.2.0',
            path: '/Users/me/.debrute/bin/debrute',
            skillsVersion: '0.2.0',
            skillsRoot: '/Users/me/.agents/skills'
          },
          update: {
            type: 'error' as const,
            currentVersion: '0.2.0',
            operation: 'apply' as const,
            message: 'Product update desktopInstallPath is required.',
            updateVersion: '0.3.0'
          }
        }
      }))
    };

    await expect(runDaemonCliCommand({
      command: 'update',
      positional: [],
      options: {}
    }, {
      server: {} as DebruteAppServer,
      productServices: {
        managedCli: {
          ensureCurrent: vi.fn(),
          diagnostic: vi.fn()
        },
        productUpdate
      }
    })).resolves.toEqual({
      status: 'error',
      command: 'update',
      code: 'product_update_failed',
      message: 'Product update desktopInstallPath is required.',
      fields: {
        current_version: '0.2.0',
        update_state: 'error',
        update_version: '0.3.0'
      }
    });
  });

  it('reports skills.status from the runtime-owned managed CLI diagnostic', async () => {
    await expect(runDaemonCliCommand({
      command: 'skills.status',
      positional: [],
      options: {}
    }, {
      server: {} as DebruteAppServer,
      productServices: {
        managedCli: {
          ensureCurrent: vi.fn(),
          diagnostic: vi.fn(() => ({
            status: 'ready' as const,
            version: '0.2.0',
            path: '/Users/me/.debrute/bin/debrute',
            skillsVersion: '0.2.0',
            skillsRoot: '/Users/me/.agents/skills'
          }))
        },
        productUpdate: {
          state: vi.fn(),
          check: vi.fn(),
          apply: vi.fn()
        }
      }
    })).resolves.toEqual({
      status: 'ok',
      command: 'skills.status',
      fields: {
        cli_status: 'ready',
        cli_version: '0.2.0',
        cli_path: '/Users/me/.debrute/bin/debrute',
        skills_version: '0.2.0',
        skills_root: '/Users/me/.agents/skills'
      }
    });
  });

  it('includes product diagnostics in runtime.status and runtime.doctor', async () => {
    const managedCli = {
      ensureCurrent: vi.fn(),
      diagnostic: vi.fn(() => ({
        status: 'error' as const,
        version: '0.2.0',
        path: '/Users/me/.debrute/bin/debrute',
        message: 'Product payload manifest is invalid.'
      }))
    };
    const services = {
      server: {
        runtimeStatusForCli: vi.fn(async () => ({
          ok: true,
          imageModels: 0,
          availableImageModels: 0,
          videoModels: 0,
          availableVideoModels: 0,
          audioModels: 0,
          availableAudioModels: 0,
          diagnostics: 0
        })),
        runtimeDoctorForCli: vi.fn(async () => ({ diagnostics: [] }))
      } as unknown as DebruteAppServer,
      productServices: {
        managedCli,
        productUpdate: {
          state: vi.fn(),
          check: vi.fn(),
          apply: vi.fn()
        }
      }
    };

    await expect(runDaemonCliCommand({
      command: 'runtime.status',
      positional: [],
      options: {}
    }, services)).resolves.toMatchObject({
      status: 'ok',
      command: 'runtime.status',
      fields: {
        product_version: '0.2.0',
        cli_status: 'error',
        cli_version: '0.2.0',
        cli_path: '/Users/me/.debrute/bin/debrute'
      }
    });

    await expect(runDaemonCliCommand({
      command: 'runtime.doctor',
      positional: [],
      options: {}
    }, services)).resolves.toMatchObject({
      status: 'ok',
      command: 'runtime.doctor',
      records: [{
        name: 'diagnostic',
        fields: {
          code: 'managed_cli_error',
          severity: 'error',
          message: 'Product payload manifest is invalid.'
        }
      }],
      fields: { diagnostics: 1 }
    });
  });
});
