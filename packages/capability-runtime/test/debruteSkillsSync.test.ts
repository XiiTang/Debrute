import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DebruteSkillsSyncError,
  createDebruteSkillsSyncService
} from '../src/debruteSkillsSync';

interface Fixture {
  root: string;
  home: string;
  bundle: string;
  shared: string;
  statePath: string;
}

describe('Debrute Skills sync service', () => {
  it('keeps status read-only when shared state is absent', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-core');
      const service = createService(fixture);

      const snapshot = await service.status();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.statePath).toBe(fixture.statePath);
      await expect(pathExists(fixture.shared)).resolves.toBe(false);
      await expect(pathExists(fixture.statePath)).resolves.toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reports valid installed Debrute-managed Skills and ignores non-Debrute Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.shared, 'debrute-core', { version: '0.9.0' });
      await writeSkill(fixture.shared, 'custom-skill', { managed: false });
      const service = createService(fixture);

      const snapshot = await service.status();

      expect(snapshot.skills.map((skill) => skill.name)).toEqual(['debrute-core']);
      expect(snapshot.skills[0]?.debruteVersion).toBe('0.9.0');
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reports invalid installed Debrute-managed Skills as diagnostics', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.shared, 'debrute-bad', { frontmatterName: 'debrute-other' });
      const service = createService(fixture, { bundledSkillsRoot: undefined });

      const snapshot = await service.status();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain('debrute_skill_name_mismatch');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('normal sync updates installed official Skills, adds new official Skills, and skips user-deleted official Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-core', { body: 'new core' });
      await writeSkill(fixture.bundle, 'debrute-new', { body: 'new skill' });
      await writeSkill(fixture.bundle, 'debrute-optional', { body: 'optional skill' });
      await writeSkill(fixture.shared, 'debrute-core', { body: 'old core' });
      await mkdir(join(fixture.home, '.debrute'), { recursive: true });
      await writeFile(fixture.statePath, `${JSON.stringify({
        schemaVersion: 1,
        debruteVersion: '1.0.0',
        bundledSkills: ['debrute-core', 'debrute-optional'],
        updatedSkills: ['debrute-core', 'debrute-optional'],
        addedBundledSkills: [],
        skippedDeletedSkills: [],
        diagnostics: [],
        updatedAt: '2026-05-01T00:00:00.000Z'
      }, null, 2)}\n`, 'utf8');
      const service = createService(fixture);

      const sync = await service.sync({ force: false });

      expect(sync.updatedSkills.map((skill) => skill.name)).toEqual(['debrute-core', 'debrute-new']);
      expect(sync.addedBundledSkills.map((skill) => skill.name)).toEqual(['debrute-new']);
      expect(sync.skippedDeletedSkills).toEqual(['debrute-optional']);
      await expect(readFile(join(fixture.shared, 'debrute-core', 'SKILL.md'), 'utf8')).resolves.toContain('new core');
      await expect(readFile(join(fixture.shared, 'debrute-new', 'SKILL.md'), 'utf8')).resolves.toContain('new skill');
      await expect(pathExists(join(fixture.shared, 'debrute-optional'))).resolves.toBe(false);
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as {
        debruteVersion: string;
        bundledSkills: string[];
        updatedSkills: string[];
        addedBundledSkills: string[];
        skippedDeletedSkills: string[];
      };
      expect(state.debruteVersion).toBe('1.2.3');
      expect(state.bundledSkills).toEqual(['debrute-core', 'debrute-new', 'debrute-optional']);
      expect(state.updatedSkills).toEqual(['debrute-core', 'debrute-new']);
      expect(state.addedBundledSkills).toEqual(['debrute-new']);
      expect(state.skippedDeletedSkills).toEqual(['debrute-optional']);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('normal sync installs all bundled Skills when state is absent', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-core');
      await writeSkill(fixture.bundle, 'debrute-image-director');
      const service = createService(fixture);

      const sync = await service.sync({ force: false });

      expect(sync.updatedSkills.map((skill) => skill.name)).toEqual(['debrute-core', 'debrute-image-director']);
      expect(sync.addedBundledSkills.map((skill) => skill.name)).toEqual(['debrute-core', 'debrute-image-director']);
      expect(sync.skippedDeletedSkills).toEqual([]);
      expect(sync.missingBundledSkills).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('force sync restores every bundled Debrute Skill without removing non-Debrute Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-core', { body: 'force core' });
      await writeSkill(fixture.bundle, 'debrute-optional', { body: 'force optional' });
      await writeSkill(fixture.shared, 'debrute-core', { body: 'stale core' });
      await writeSkill(fixture.shared, 'custom-skill', { managed: false, body: 'custom stays' });
      await mkdir(join(fixture.home, '.debrute'), { recursive: true });
      await writeFile(fixture.statePath, `${JSON.stringify({
        schemaVersion: 1,
        debruteVersion: '1.0.0',
        bundledSkills: ['debrute-core', 'debrute-optional'],
        updatedSkills: ['debrute-core'],
        addedBundledSkills: [],
        skippedDeletedSkills: ['debrute-optional'],
        diagnostics: [],
        updatedAt: '2026-05-01T00:00:00.000Z'
      }, null, 2)}\n`, 'utf8');
      const service = createService(fixture);

      const sync = await service.sync({ force: true });

      expect(sync.updatedSkills.map((skill) => skill.name)).toEqual(['debrute-core', 'debrute-optional']);
      expect(sync.addedBundledSkills.map((skill) => skill.name)).toEqual([]);
      expect(sync.skippedDeletedSkills).toEqual([]);
      await expect(readFile(join(fixture.shared, 'debrute-core', 'SKILL.md'), 'utf8')).resolves.toContain('force core');
      await expect(readFile(join(fixture.shared, 'debrute-optional', 'SKILL.md'), 'utf8')).resolves.toContain('force optional');
      await expect(readFile(join(fixture.shared, 'custom-skill', 'SKILL.md'), 'utf8')).resolves.toContain('custom stays');
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as { skippedDeletedSkills: string[] };
      expect(state.skippedDeletedSkills).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reports invalid state during status and refuses normal sync until state is removed or force sync is used', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-core');
      await mkdir(join(fixture.home, '.debrute'), { recursive: true });
      await writeFile(fixture.statePath, '{not-json', 'utf8');
      const service = createService(fixture);

      const before = await service.status();
      expect(before.diagnostics.map((diagnostic) => diagnostic.code)).toContain('skills_state_unreadable');

      await expect(service.sync({ force: false })).rejects.toMatchObject({ code: 'skills_state_unreadable' });
      await expect(readFile(fixture.statePath, 'utf8')).resolves.toBe('{not-json');

      const forced = await service.sync({ force: true });
      expect(forced.updatedSkills.map((skill) => skill.name)).toEqual(['debrute-core']);
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as {
        schemaVersion: number;
        bundledSkills: string[];
        skippedDeletedSkills: string[];
      };
      expect(state.schemaVersion).toBe(1);
      expect(state.bundledSkills).toEqual(['debrute-core']);
      expect(state.skippedDeletedSkills).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('fails sync when bundled Debrute Skills are invalid', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'debrute-bad', { frontmatterName: 'debrute-other' });
      const service = createService(fixture);

      await expect(service.sync({ force: false })).rejects.toMatchObject({ code: 'skills_bundle_invalid' });
      await expect(pathExists(fixture.shared)).resolves.toBe(false);
      await expect(pathExists(fixture.statePath)).resolves.toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns skills_bundle_unavailable for sync while status still works without a bundled root', async () => {
    const fixture = await createFixture();
    try {
      const service = createService(fixture, { bundledSkillsRoot: undefined });

      const status = await service.status();
      expect(status.skills).toEqual([]);
      expect(status.diagnostics).toContainEqual(expect.objectContaining({
        code: 'skills_bundle_unavailable',
        message: expect.stringContaining('not configured')
      }));
      await expect(service.sync({ force: false })).rejects.toBeInstanceOf(DebruteSkillsSyncError);
      await expect(service.sync({ force: false })).rejects.toMatchObject({ code: 'skills_bundle_unavailable' });
    } finally {
      await cleanupFixture(fixture);
    }
  });

});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'debrute-skills-sync-'));
  const home = join(root, 'home');
  const bundle = join(root, 'bundle');
  const shared = join(home, '.agents', 'skills');
  const statePath = join(home, '.debrute', 'skills-state.json');
  await mkdir(bundle, { recursive: true });
  return { root, home, bundle, shared, statePath };
}

function createService(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createDebruteSkillsSyncService>[0]> = {}
) {
  return createDebruteSkillsSyncService({
    userHome: fixture.home,
    bundledSkillsRoot: fixture.bundle,
    debruteVersion: '1.2.3',
    now: () => '2026-05-31T00:00:00.000Z',
    tempName: (skillName) => `.${skillName}.tmp`,
    ...overrides
  });
}

async function writeSkill(
  root: string,
  name: string,
  options: {
    body?: string;
    version?: string;
    managed?: boolean;
    frontmatterName?: string;
    extraFiles?: Record<string, string>;
  } = {}
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const managed = options.managed ?? true;
  await writeFile(join(dir, 'SKILL.md'), [
    '---',
    `name: ${options.frontmatterName ?? name}`,
    `description: ${name} description`,
    'metadata:',
    `  debrute.managed: "${managed ? 'true' : 'false'}"`,
    '  debrute.package: "debrute"',
    `  debrute.version: "${options.version ?? '1.2.3'}"`,
    '---',
    '',
    options.body ?? `${name} body`,
    ''
  ].join('\n'), 'utf8');
  for (const [relativePath, content] of Object.entries(options.extraFiles ?? {})) {
    const absolutePath = join(dir, relativePath);
    await mkdir(join(absolutePath, '..'), { recursive: true });
    await writeFile(absolutePath, content, 'utf8');
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}
