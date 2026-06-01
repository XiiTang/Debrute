import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('desktop update package configuration', () => {
  it('publishes packaged updates to the public AXIS GitHub repository', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));

    expect(packageJson.dependencies['electron-updater']).toBeDefined();
    expect(packageJson.build.publish).toEqual([{
      provider: 'github',
      owner: 'XiiTang',
      repo: 'AXIS',
      releaseType: 'release'
    }]);
    expect(packageJson.build.mac.target).toContain('dmg');
    expect(packageJson.build.win.target).toContain('nsis');
  });
});
