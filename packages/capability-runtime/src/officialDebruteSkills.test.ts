import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OfficialDebruteSkillsMaterializeError,
  createOfficialDebruteSkillsMaterializer
} from './officialDebruteSkills.js';

interface Fixture {
  root: string;
  home: string;
  payload: string;
  shared: string;
  statePath: string;
}

describe('Official Debrute Skills materializer', () => {
  it('keeps status read-only when shared Skills are absent', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.payload, 'debrute-core');
      const materializer = createMaterializer(fixture);

      const snapshot = await materializer.status();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.payloadSkills).toEqual(['debrute-core']);
      expect(snapshot.payloadRootAvailable).toBe(true);
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
      const materializer = createMaterializer(fixture);

      const snapshot = await materializer.status();

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
      const materializer = createMaterializer(fixture, { payloadSkillsRoot: undefined });

      const snapshot = await materializer.status();

      expect(snapshot.skills).toEqual([]);
      expect(snapshot.diagnostics.map((diagnostic) => diagnostic.code)).toContain('debrute_skill_name_mismatch');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('materializes the current payload as the complete official Skills set without state', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.payload, 'debrute-core', { body: 'current core' });
      await writeSkill(fixture.shared, 'debrute-old', { body: 'removed official' });
      await writeSkill(fixture.shared, 'custom-skill', { managed: false, body: 'custom stays' });
      const materializer = createMaterializer(fixture);

      const snapshot = await materializer.materialize();

      expect(snapshot.materializedSkills.map((skill) => skill.name)).toEqual(['debrute-core']);
      await expect(readFile(join(fixture.shared, 'debrute-core', 'SKILL.md'), 'utf8')).resolves.toContain('current core');
      await expect(pathExists(join(fixture.shared, 'debrute-old'))).resolves.toBe(false);
      await expect(readFile(join(fixture.shared, 'custom-skill', 'SKILL.md'), 'utf8')).resolves.toContain('custom stays');
      await expect(pathExists(fixture.statePath)).resolves.toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('materializes every payload Skill for the current product version', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.payload, 'debrute-core', { body: 'new core' });
      await writeSkill(fixture.payload, 'debrute-image-director', { body: 'image skill' });
      await writeSkill(fixture.payload, 'debrute-video-director', { body: 'video skill' });
      const materializer = createMaterializer(fixture);

      const snapshot = await materializer.materialize();

      expect(snapshot.materializedSkills.map((skill) => skill.name)).toEqual([
        'debrute-core',
        'debrute-image-director',
        'debrute-video-director'
      ]);
      await expect(readFile(join(fixture.shared, 'debrute-image-director', 'SKILL.md'), 'utf8')).resolves.toContain('image skill');
      await expect(readFile(join(fixture.shared, 'debrute-video-director', 'SKILL.md'), 'utf8')).resolves.toContain('video skill');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('does not delete a user skill without official Debrute metadata', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.payload, 'debrute-core', { body: 'payload core' });
      await writeSkill(fixture.shared, 'debrute-user-skill', {
        managed: false,
        body: 'user owned'
      });
      const materializer = createMaterializer(fixture);

      await materializer.materialize();

      await expect(readFile(join(fixture.shared, 'debrute-user-skill', 'SKILL.md'), 'utf8')).resolves.toContain('user owned');
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('fails materialize when payload Skills are invalid without writing shared Skills', async () => {
    const fixture = await createFixture();
    try {
      await writeSkill(fixture.payload, 'debrute-bad', { frontmatterName: 'debrute-other' });
      const materializer = createMaterializer(fixture);

      await expect(materializer.materialize()).rejects.toMatchObject({ code: 'skills_payload_invalid' });
      await expect(pathExists(fixture.shared)).resolves.toBe(false);
      await expect(pathExists(fixture.statePath)).resolves.toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });

  it('returns skills_payload_unavailable for materialize while status still works without a payload root', async () => {
    const fixture = await createFixture();
    try {
      const materializer = createMaterializer(fixture, { payloadSkillsRoot: undefined });

      const status = await materializer.status();
      expect(status.skills).toEqual([]);
      expect(status.diagnostics).toContainEqual(expect.objectContaining({
        code: 'skills_payload_unavailable',
        message: expect.stringContaining('not configured')
      }));
      await expect(materializer.materialize()).rejects.toBeInstanceOf(OfficialDebruteSkillsMaterializeError);
      await expect(materializer.materialize()).rejects.toMatchObject({ code: 'skills_payload_unavailable' });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'debrute-skills-materialize-'));
  const home = join(root, 'home');
  const payload = join(root, 'payload');
  const shared = join(home, '.agents', 'skills');
  const statePath = join(home, '.debrute', 'skills-state.json');
  await mkdir(payload, { recursive: true });
  return { root, home, payload, shared, statePath };
}

function createMaterializer(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof createOfficialDebruteSkillsMaterializer>[0]> = {}
) {
  return createOfficialDebruteSkillsMaterializer({
    userHome: fixture.home,
    payloadSkillsRoot: fixture.payload,
    debruteVersion: '1.2.3',
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
