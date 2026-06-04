import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AxisSkillsSyncError,
  createAxisSkillsSyncService
} from '../src/axisSkillsSync';

interface Fixture {
  root: string;
  home: string;
  bundle: string;
  shared: string;
  statePath: string;
}

describe('Axis Skills sync service', () => {
  it('keeps status read-only when shared state is absent', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'axis-core');
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

  it('reports valid installed AXIS-managed Skills and ignores non-AXIS Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.shared, 'axis-core', { version: '0.9.0' });
      await writeSkill(fixture.shared, 'custom-skill', { managed: false });
      const service = createService(fixture);

      const snapshot = await service.status();

      expect(snapshot.skills.map((skill) => skill.name)).toEqual(['axis-core']);
      expect(snapshot.skills[0]?.axisVersion).toBe('0.9.0');
      expect(snapshot.diagnostics).toEqual([]);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reports invalid installed AXIS-managed Skills as diagnostics', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.shared, 'axis-bad', { frontmatterName: 'axis-other' });
      const service = createService(fixture, { bundledSkillsRoot: undefined });

      const snapshot = await service.status();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain('axis_skill_name_mismatch');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('normal sync installs the current bundled AXIS Skills payload', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'axis-core', { body: 'new core' });
      await writeSkill(fixture.bundle, 'axis-new', { body: 'new skill' });
      await writeSkill(fixture.bundle, 'axis-optional', { body: 'optional skill' });
      await writeSkill(fixture.shared, 'axis-core', { body: 'old core' });
      const service = createService(fixture);

      const sync = await service.sync({ force: false });

      expect(sync.updatedSkills.map((skill) => skill.name)).toEqual(['axis-core', 'axis-new', 'axis-optional']);
      await expect(readFile(join(fixture.shared, 'axis-core', 'SKILL.md'), 'utf8')).resolves.toContain('new core');
      await expect(readFile(join(fixture.shared, 'axis-new', 'SKILL.md'), 'utf8')).resolves.toContain('new skill');
      await expect(readFile(join(fixture.shared, 'axis-optional', 'SKILL.md'), 'utf8')).resolves.toContain('optional skill');
      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as { axisVersion: string; bundledSkills: string[]; updatedSkills: string[] };
      expect(state.axisVersion).toBe('1.2.3');
      expect(state.bundledSkills).toEqual(['axis-core', 'axis-new', 'axis-optional']);
      expect(state.updatedSkills).toEqual(['axis-core', 'axis-new', 'axis-optional']);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('force sync restores every bundled AXIS Skill without removing non-AXIS Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'axis-core', { body: 'force core' });
      await writeSkill(fixture.bundle, 'axis-optional', { body: 'force optional' });
      await writeSkill(fixture.shared, 'axis-core', { body: 'stale core' });
      await writeSkill(fixture.shared, 'custom-skill', { managed: false, body: 'custom stays' });
      const service = createService(fixture);

      const sync = await service.sync({ force: true });

      expect(sync.updatedSkills.map((skill) => skill.name)).toEqual(['axis-core', 'axis-optional']);
      await expect(readFile(join(fixture.shared, 'axis-core', 'SKILL.md'), 'utf8')).resolves.toContain('force core');
      await expect(readFile(join(fixture.shared, 'axis-optional', 'SKILL.md'), 'utf8')).resolves.toContain('force optional');
      await expect(readFile(join(fixture.shared, 'custom-skill', 'SKILL.md'), 'utf8')).resolves.toContain('custom stays');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('reports invalid state during status and replaces it after successful sync', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.bundle, 'axis-core');
      await mkdir(join(fixture.home, '.axis'), { recursive: true });
      await writeFile(fixture.statePath, '{not-json', 'utf8');
      const service = createService(fixture);

      const before = await service.status();
      expect(before.diagnostics.map((diagnostic) => diagnostic.code)).toContain('skills_state_unreadable');

      await service.sync({ force: false });

      const state = JSON.parse(await readFile(fixture.statePath, 'utf8')) as { schemaVersion: number; bundledSkills: string[] };
      expect(state.schemaVersion).toBe(1);
      expect(state.bundledSkills).toEqual(['axis-core']);
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
      await expect(service.sync({ force: false })).rejects.toBeInstanceOf(AxisSkillsSyncError);
      await expect(service.sync({ force: false })).rejects.toMatchObject({ code: 'skills_bundle_unavailable' });
    } finally {
      await cleanupFixture(fixture);
    }
  });

});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'axis-skills-sync-'));
  const home = join(root, 'home');
  const bundle = join(root, 'bundle');
  const shared = join(home, '.agents', 'skills');
  const statePath = join(home, '.axis', 'skills-state.json');
  await mkdir(bundle, { recursive: true });
  return { root, home, bundle, shared, statePath };
}

function createService(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createAxisSkillsSyncService>[0]> = {}
) {
  return createAxisSkillsSyncService({
    userHome: fixture.home,
    bundledSkillsRoot: fixture.bundle,
    axisVersion: '1.2.3',
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
    `  axis.managed: "${managed ? 'true' : 'false'}"`,
    '  axis.package: "axis"',
    `  axis.version: "${options.version ?? '1.2.3'}"`,
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
