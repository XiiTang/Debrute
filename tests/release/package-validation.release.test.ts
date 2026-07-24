import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { validateZipEntries } from '../../scripts/package-validation.mjs';

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
});
