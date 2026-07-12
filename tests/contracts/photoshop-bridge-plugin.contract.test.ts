import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Photoshop bridge plugin contract', () => {
  it('declares the UXP bridge package and public manifest', () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const manifest = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), 'utf8')) as {
      id?: string;
      host?: { app?: string };
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(manifest).toMatchObject({
      id: 'com.debrute.photoshop.bridge',
      host: { app: 'PS' }
    });
  });

  it('declares the CEP bridge package and public manifest', () => {
    const root = process.cwd();
    const manifest = readFileSync(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-cep-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(manifest).toContain('ExtensionBundleId="com.debrute.photoshop.bridge.cep"');
  });
});
