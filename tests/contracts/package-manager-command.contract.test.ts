import { describe, expect, it } from 'vitest';
import { packageManagerCommand } from '../../scripts/package-manager-command.mjs';

describe('packageManagerCommand', () => {
  it('launches the declared pnpm version through Corepack when available', () => {
    const command = packageManagerCommand('/workspace', ['--version'], services({
      platform: 'win32',
      corepackExists: true
    }));

    expect(command.command).toBe('/node/bin/node');
    expect(command.args).toEqual([
      expect.stringContaining('corepack'),
      'pnpm',
      '--version'
    ]);
  });

  it('does not fall back to Windows command shims without Corepack', () => {
    expect(() => packageManagerCommand('/workspace', [], services({
      platform: 'win32',
      corepackExists: false
    }))).toThrow(/Corepack is required/);
  });

  it('allows PATH resolution on non-Windows when Corepack is unavailable', () => {
    expect(packageManagerCommand('/workspace', ['check'], services({
      platform: 'linux',
      corepackExists: false
    }))).toEqual({
      command: 'pnpm',
      args: ['check']
    });
  });

  it('rejects unsupported workspace package managers', () => {
    expect(() => packageManagerCommand('/workspace', [], services({
      packageManager: 'npm@11.0.0'
    }))).toThrow(/Unsupported package manager/);
  });
});

function services({
  platform = 'linux',
  corepackExists = true,
  packageManager = 'pnpm@11.2.2'
} = {}) {
  return {
    platform,
    execPath: '/node/bin/node',
    existsSync: () => corepackExists,
    readFileSync: () => JSON.stringify({ packageManager })
  };
}
