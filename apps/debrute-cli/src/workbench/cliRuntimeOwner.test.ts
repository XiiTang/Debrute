import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCliRuntimeOwner } from './cliRuntimeOwner.js';

describe('CLI runtime owner', { tags: ['runtime'] }, () => {
  it('creates a stable CLI owner id when no owner state exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-owner-create-'));
    try {
      const owner = await resolveCliRuntimeOwner(root);
      const again = await resolveCliRuntimeOwner(root);

      expect(owner.kind).toBe('cli');
      expect(again.ownerId).toBe(owner.ownerId);
      await expect(readFile(join(root, 'cli-owner.json'), 'utf8')).resolves.toContain(owner.ownerId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects malformed CLI owner state instead of silently changing owner id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-owner-invalid-'));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'cli-owner.json'), JSON.stringify({
        ownerId: ''
      }), 'utf8');

      await expect(resolveCliRuntimeOwner(root)).rejects.toThrow(
        'Invalid Debrute CLI runtime owner state: ownerId must be a non-empty string.'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unreadable CLI owner JSON instead of silently changing owner id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'debrute-cli-owner-json-'));
    try {
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'cli-owner.json'), '{not-json', 'utf8');

      await expect(resolveCliRuntimeOwner(root)).rejects.toThrow(
        'Invalid Debrute CLI runtime owner state:'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
