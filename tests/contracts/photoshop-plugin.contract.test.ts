import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Photoshop plugin contract', () => {
  it('loads the UXP receiver with Photoshop and owns only its direct protocol dependency', () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const manifest = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), 'utf8')) as {
      id?: string;
      manifestVersion?: number;
      host?: { app?: string; minVersion?: string; data?: { apiVersion?: number; loadEvent?: string } };
      requiredPermissions?: {
        localFileSystem?: string;
        network?: { domains?: string[] | 'all' };
      };
    };

    expect(packageJson.dependencies ?? {}).toEqual({
      '@debrute/app-protocol': 'workspace:*',
      fflate: '0.8.2'
    });
    expect(manifest).toMatchObject({
      manifestVersion: 5,
      id: 'com.debrute.photoshop',
      host: {
        app: 'PS',
        minVersion: '24.4.0',
        data: {
          apiVersion: 2,
          loadEvent: 'startup'
        }
      },
      requiredPermissions: {
        localFileSystem: 'plugin',
        network: {
          domains: 'all'
        }
      }
    });
  });
});
