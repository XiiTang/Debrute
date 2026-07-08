import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import {
  validateDebruteCliRuntimePayload,
  validateZipEntries
} from '../scripts/package-validation.mjs';

describe('package validation helpers', () => {
  it('accepts zip archives with current required entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-zip-validation-'));
    const zipPath = join(root, 'plugin.zip');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    zip.addFile('assets/main.js', Buffer.from(''));
    await new Promise<void>((resolve, reject) => {
      zip.writeZip(zipPath, (error) => error ? reject(error) : resolve());
    });

    expect(() => validateZipEntries(zipPath, ['manifest.json', 'assets/main.js'])).not.toThrow();
  });

  it('rejects zip archives missing a current required entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-zip-validation-missing-'));
    const zipPath = join(root, 'plugin.zip');
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from('{}'));
    await new Promise<void>((resolve, reject) => {
      zip.writeZip(zipPath, (error) => error ? reject(error) : resolve());
    });

    expect(() => validateZipEntries(zipPath, ['manifest.json', 'assets/main.js']))
      .toThrow('Package archive is missing required entry: assets/main.js');
  });

  it('validates the current CLI host payload shape and runtime payload entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-payload-validation-'));
    await mkdir(join(root, 'official-docs/imageModels/snapshots'), { recursive: true });
    await mkdir(join(root, 'official-docs/videoModels/snapshots'), { recursive: true });
    await mkdir(join(root, 'official-docs/audioModels/snapshots'), { recursive: true });
    await mkdir(join(root, 'node_modules/sharp'), { recursive: true });
    await writeFile(join(root, 'debrute'), '');
    await writeFile(join(root, 'package.json'), '{"version":"0.0.2"}\n');
    await writeFile(join(root, 'node_modules/sharp/package.json'), '{}\n');

    await expect(validateDebruteCliRuntimePayload(root, { executableName: 'debrute' }, [
      { to: 'node_modules/sharp/package.json' }
    ])).resolves.toBeUndefined();
  });

  it('rejects CLI host payloads missing a current runtime payload entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-payload-validation-missing-'));
    await mkdir(join(root, 'official-docs/imageModels/snapshots'), { recursive: true });
    await mkdir(join(root, 'official-docs/videoModels/snapshots'), { recursive: true });
    await mkdir(join(root, 'official-docs/audioModels/snapshots'), { recursive: true });
    await writeFile(join(root, 'debrute'), '');
    await writeFile(join(root, 'package.json'), '{"version":"0.0.2"}\n');

    await expect(validateDebruteCliRuntimePayload(root, { executableName: 'debrute' }, [
      { to: 'node_modules/node-pty/package.json' }
    ])).rejects.toThrow('Package output is missing required path: node_modules/node-pty/package.json');
  });
});
