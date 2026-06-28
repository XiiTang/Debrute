import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  releaseVersionContract,
  validateReleaseVersionContract
} from '../scripts/validate-release-version-contract.mjs';

describe('release version contract', () => {
  it('keeps root, Desktop, Debrute CLI, and bundled Skills on one product version', async () => {
    const contract = await releaseVersionContract(process.cwd());
    const rootPackage = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { version: string };

    expect(contract.version).toBe(rootPackage.version);
    expect(contract.entries.map((entry) => entry.label)).toEqual([
      'root package',
      'Desktop package',
      'Debrute CLI package',
      'Photoshop UXP package',
      'Photoshop UXP manifest',
      'Photoshop CEP package',
      'Photoshop CEP manifest',
      'debrute-core Skill',
      'debrute-image-director Skill',
      'debrute-video-director Skill'
    ]);
    expect(contract.entries.every((entry) => entry.version === contract.version)).toBe(true);
  });

  it('rejects mismatched package and Skill versions instead of publishing a mixed release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-release-version-contract-'));
    try {
      await mkdir(join(root, 'apps/desktop'), { recursive: true });
      await mkdir(join(root, 'apps/debrute-cli'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-uxp-plugin'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-uxp-plugin/public'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-cep-plugin/public/CSXS'), { recursive: true });
      await mkdir(join(root, 'skills/debrute-core'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/debrute-cli/package.json'), JSON.stringify({ version: '1.2.4' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), '<ExtensionManifest ExtensionBundleVersion="1.2.3"></ExtensionManifest>', 'utf8');
      await writeFile(join(root, 'skills/debrute-core/SKILL.md'), [
        '---',
        'name: debrute-core',
        'metadata:',
        '  debrute.version: "1.2.5"',
        '---',
        ''
      ].join('\n'), 'utf8');

      await expect(validateReleaseVersionContract(root)).rejects.toThrow(/release version mismatch/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects version fields on internal runtime workspace packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-release-internal-version-contract-'));
    try {
      await mkdir(join(root, 'apps/desktop'), { recursive: true });
      await mkdir(join(root, 'apps/debrute-cli'), { recursive: true });
      await mkdir(join(root, 'apps/daemon'), { recursive: true });
      await mkdir(join(root, 'apps/runtime-host'), { recursive: true });
      await mkdir(join(root, 'apps/web'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-uxp-plugin/public'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-cep-plugin/public/CSXS'), { recursive: true });
      await mkdir(join(root, 'skills/debrute-core'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/debrute-cli/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/daemon/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/runtime-host/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/web/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), '<ExtensionManifest ExtensionBundleVersion="1.2.3"></ExtensionManifest>', 'utf8');
      await writeFile(join(root, 'skills/debrute-core/SKILL.md'), [
        '---',
        'name: debrute-core',
        'metadata:',
        '  debrute.version: "1.2.3"',
        '---',
        ''
      ].join('\n'), 'utf8');

      await expect(validateReleaseVersionContract(root)).rejects.toThrow(/internal package versions/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects mismatched Photoshop UXP manifest versions instead of packaging mixed metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-release-uxp-manifest-contract-'));
    try {
      await mkdir(join(root, 'apps/desktop'), { recursive: true });
      await mkdir(join(root, 'apps/debrute-cli'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-uxp-plugin/public'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-cep-plugin/public/CSXS'), { recursive: true });
      await mkdir(join(root, 'skills/debrute-core'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/debrute-cli/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), JSON.stringify({ version: '1.2.4' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), '<ExtensionManifest ExtensionBundleVersion="1.2.3"></ExtensionManifest>', 'utf8');
      await writeFile(join(root, 'skills/debrute-core/SKILL.md'), [
        '---',
        'name: debrute-core',
        'metadata:',
        '  debrute.version: "1.2.3"',
        '---',
        ''
      ].join('\n'), 'utf8');

      await expect(validateReleaseVersionContract(root)).rejects.toThrow(/photoshop uxp manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects mismatched Photoshop CEP manifest versions instead of packaging mixed metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-release-cep-manifest-contract-'));
    try {
      await mkdir(join(root, 'apps/desktop'), { recursive: true });
      await mkdir(join(root, 'apps/debrute-cli'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-uxp-plugin/public'), { recursive: true });
      await mkdir(join(root, 'apps/photoshop-cep-plugin/public/CSXS'), { recursive: true });
      await mkdir(join(root, 'skills/debrute-core'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/debrute-cli/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-uxp-plugin/public/manifest.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/package.json'), JSON.stringify({ version: '1.2.3' }), 'utf8');
      await writeFile(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), '<ExtensionManifest ExtensionBundleVersion="1.2.4"></ExtensionManifest>', 'utf8');
      await writeFile(join(root, 'skills/debrute-core/SKILL.md'), [
        '---',
        'name: debrute-core',
        'metadata:',
        '  debrute.version: "1.2.3"',
        '---',
        ''
      ].join('\n'), 'utf8');

      await expect(validateReleaseVersionContract(root)).rejects.toThrow(/photoshop cep manifest/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
