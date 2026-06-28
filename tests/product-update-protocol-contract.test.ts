import { describe, expect, it } from 'vitest';
import type {
  DebruteProductState,
  ManagedCliDiagnostic,
  ProductUpdateApplyResult,
  ProductUpdateOperation,
  ProductUpdateState,
  WorkbenchApiClient
} from '@debrute/app-protocol';

describe('runtime product update protocol contract', () => {
  it('models product state, managed CLI diagnostics, and whole-product update states', () => {
    const operations: ProductUpdateOperation[] = ['check', 'apply'];
    const readyCli: ManagedCliDiagnostic = {
      status: 'ready',
      version: '0.2.0',
      path: '/Users/me/.debrute/bin/debrute',
      skillsVersion: '0.2.0',
      skillsRoot: '/Users/me/.agents/skills'
    };
    const erroredCli: ManagedCliDiagnostic = {
      status: 'error',
      version: '0.2.0',
      path: '/Users/me/.debrute/bin/debrute',
      message: 'Product payload manifest is invalid.',
      logPath: '/Users/me/.debrute/logs/runtime.log'
    };
    const states: ProductUpdateState[] = [
      { type: 'idle', currentVersion: '0.2.0', updateAvailable: false },
      { type: 'checking', currentVersion: '0.2.0' },
      {
        type: 'available',
        currentVersion: '0.2.0',
        updateVersion: '0.3.0',
        releaseName: 'Debrute 0.3.0',
        releaseDate: '2026-06-28T00:00:00.000Z'
      },
      { type: 'installing', currentVersion: '0.2.0', updateVersion: '0.3.0' },
      {
        type: 'error',
        currentVersion: '0.2.0',
        operation: operations[1],
        message: 'checksum failed',
        updateVersion: '0.3.0',
        logPath: '/Users/me/.debrute/logs/update.log'
      }
    ];
    const product: DebruteProductState = {
      productVersion: '0.2.0',
      platform: 'darwin',
      cli: readyCli,
      update: states[0]!
    };
    const apply: ProductUpdateApplyResult = {
      state: {
        ...product,
        cli: erroredCli,
        update: states[4]!
      }
    };

    expect(states.map((state) => state.type)).toEqual(['idle', 'checking', 'available', 'installing', 'error']);
    expect(product.productVersion).toBe(product.cli.version);
    expect(apply.state.update.type).toBe('error');
  });

  it('exposes runtime product methods on WorkbenchApiClient', () => {
    type Expected = Pick<WorkbenchApiClient, 'getProductState' | 'checkProductUpdate' | 'applyProductUpdate'>;
    const client = {} as Expected;

    expect(client).toBeDefined();
  });
});
