import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSourceDevProductServices,
  createSourceDevProductServicesFromEnv
} from '../apps/daemon/src/product/SourceDevProductServices';

describe('source dev product services', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await rm(cleanup.pop()!, { recursive: true, force: true });
    }
  });

  it('reports source CLI diagnostics and materializes official Skills through product services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-source-product-services-'));
    cleanup.push(root);
    const skillsPayload = join(root, 'skills');
    const home = join(root, 'home');
    await writeFileRecursive(join(skillsPayload, 'debrute-core', 'SKILL.md'), [
      '---',
      'name: debrute-core',
      'description: Debrute Core',
      'metadata:',
      '  debrute.managed: "true"',
      '  debrute.package: debrute',
      '  debrute.version: "0.2.0"',
      '---',
      '# Debrute Core',
      ''
    ].join('\n'));

    const services = createSourceDevProductServices({
      productVersion: '0.2.0',
      cliPath: join(root, 'apps/debrute-cli/src/index.ts'),
      skillsPayloadDir: skillsPayload,
      userHome: home
    });

    await expect(services.managedCli.ensureCurrent()).resolves.toMatchObject({
      status: 'ready',
      version: '0.2.0',
      path: join(root, 'apps/debrute-cli/src/index.ts'),
      skillsVersion: '0.2.0',
      skillsRoot: join(home, '.agents', 'skills')
    });
    await expect(readFile(join(home, '.agents', 'skills', 'debrute-core', 'SKILL.md'), 'utf8')).resolves.toContain('Debrute Core');
    await expect(services.productUpdate.state()).resolves.toMatchObject({
      productVersion: '0.2.0',
      cli: {
        status: 'ready',
        version: '0.2.0'
      },
      update: {
        type: 'idle',
        currentVersion: '0.2.0'
      }
    });
    await expect(services.productUpdate.check()).resolves.toMatchObject({
      productVersion: '0.2.0',
      update: {
        type: 'idle',
        currentVersion: '0.2.0',
        updateAvailable: false
      }
    });
    await expect(services.productUpdate.apply()).resolves.toMatchObject({
      state: {
        productVersion: '0.2.0',
        update: {
          type: 'idle',
          currentVersion: '0.2.0',
          updateAvailable: false
        }
      }
    });
    expect('replacementHelperCommand' in services.managedCli).toBe(false);
  });

  it('requires source product metadata instead of creating a product-less daemon', () => {
    expect(() => createSourceDevProductServicesFromEnv({})).toThrow(/DEBRUTE_DAEMON_PRODUCT_VERSION/);
    expect(() => createSourceDevProductServicesFromEnv({
      DEBRUTE_DAEMON_PRODUCT_VERSION: '0.2.0'
    })).toThrow(/DEBRUTE_DAEMON_CLI_PATH.*DEBRUTE_DAEMON_SKILLS_PAYLOAD_DIR/);
  });
});

async function writeFileRecursive(path: string, content: string): Promise<void> {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, content, 'utf8');
}
