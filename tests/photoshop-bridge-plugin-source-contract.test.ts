import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const uxpSharedModulePaths = [
  'apps/photoshop-uxp-plugin/src/bridgeClient.ts',
  'apps/photoshop-uxp-plugin/src/discoveryClient.ts',
  'apps/photoshop-uxp-plugin/src/projectTreeModel.ts',
  'apps/photoshop-uxp-plugin/src/selectionModel.ts',
  'apps/photoshop-uxp-plugin/src/transferPayloads.ts'
];

describe('Photoshop bridge plugin source contract', () => {
  it('keeps UXP host code on the shared Photoshop bridge core', () => {
    const root = process.cwd();
    const main = readFileSync(join(root, 'apps/photoshop-uxp-plugin/src/main.ts'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(main).toContain("from '@debrute/photoshop-bridge-plugin-core'");
    expect(main).not.toContain("from '@debrute/app-protocol'");
    expect(main).toContain("clientRuntime: 'uxp'");
    for (const path of uxpSharedModulePaths) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it('keeps CEP host code on the shared Photoshop bridge core', () => {
    const root = process.cwd();
    const main = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/main.ts'), 'utf8');
    const manifest = readFileSync(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-cep-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(main).toContain("from '@debrute/photoshop-bridge-plugin-core'");
    expect(main).not.toContain("from '@debrute/app-protocol'");
    expect(main).toContain("clientRuntime: 'cep'");
    expect(manifest).toContain('ExtensionBundleId="com.debrute.photoshop.bridge.cep"');
  });
});
