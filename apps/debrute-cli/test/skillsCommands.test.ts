import { describe, expect, it } from 'vitest';
import type {
  SkillsStatusSnapshot,
  SkillsSyncSnapshot
} from '@debrute/app-protocol';
import type { DebruteSkillsSyncService } from '@debrute/capability-runtime';
import { parseDebruteArgs } from '../src/parser/parseDebruteArgs';
import { runRuntimeCommand } from '../src/commands/runtimeCommands';
import { resolveCliDebruteVersion } from '../src/runtime/createCliSkillsRuntime';

describe('debrute skills CLI commands', () => {
  it('parses skills sync with --force as a boolean option', () => {
    const parsed = parseDebruteArgs(['skills', 'sync', '--force']);

    expect(parsed.command).toBe('skills.sync');
    expect(parsed.options.force).toBe('true');
  });

  it('renders skills status records from the sync service', async () => {
    const result = await runRuntimeCommand(parseDebruteArgs(['skills', 'status']), {
      skillsService: fakeSkillsService()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'skills.status',
      fields: {
        skills: 1,
        diagnostics: 0,
        source_root: '/home/user/.agents/skills',
        state_path: '/home/user/.debrute/skills-state.json',
        debrute_version: '1.2.3'
      }
    });
    expect(result.records).toContainEqual(expect.objectContaining({
      name: 'skill',
      fields: expect.objectContaining({ name: 'debrute-core' })
    }));
  });

  it('renders sync updated, added, skipped, and force fields', async () => {
    const result = await runRuntimeCommand(parseDebruteArgs(['skills', 'sync']), {
      skillsService: fakeSkillsService()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'skills.sync',
      fields: {
        updated: 1,
        added: 2,
        skipped_deleted: 1,
        force: false
      }
    });
    expect(result.records).toContainEqual(expect.objectContaining({ name: 'updated_skill' }));
    expect(result.records).toContainEqual(expect.objectContaining({ name: 'added_skill' }));
    expect(result.records).toContainEqual(expect.objectContaining({
      name: 'skipped_deleted_skill',
      fields: expect.objectContaining({ name: 'debrute-example', reason: 'user_deleted' })
    }));
  });

  it('fails version resolution when package metadata is unavailable', async () => {
    await expect(resolveCliDebruteVersion('/tmp/debrute-cli-without-package/dist')).rejects.toThrow(/package metadata/i);
  });
});

function fakeSkillsService(overrides: Partial<SkillsStatusSnapshot> = {}): DebruteSkillsSyncService {
  const status: SkillsStatusSnapshot = {
    sources: [{ source: 'shared-agents', root: '/home/user/.agents/skills' }],
    skills: [{
      name: 'debrute-core',
      description: 'Core',
      source: 'shared-agents',
      root: '/home/user/.agents/skills',
      skillDir: '/home/user/.agents/skills/debrute-core',
      skillPath: '/home/user/.agents/skills/debrute-core/SKILL.md',
      debruteVersion: '1.2.3'
    }],
    diagnostics: [],
    statePath: '/home/user/.debrute/skills-state.json',
    currentDebruteVersion: '1.2.3',
    sharedSkillsRoot: '/home/user/.agents/skills',
    bundledSkillsRoot: '/Debrute/skills',
    bundledRootAvailable: true,
    bundledSkills: ['debrute-core', 'debrute-image-director', 'debrute-video-director'],
    missingBundledSkills: ['debrute-image-director', 'debrute-video-director'],
    missingBundledSkillCount: 2,
    skippedDeletedSkills: ['debrute-example'],
    ...overrides
  };
  const sync: SkillsSyncSnapshot = {
    ...status,
    force: false,
    updatedSkills: status.skills,
    addedBundledSkills: [
      {
        ...status.skills[0]!,
        name: 'debrute-image-director',
        description: 'Image Director'
      },
      {
        ...status.skills[0]!,
        name: 'debrute-video-director',
        description: 'Video Director'
      }
    ],
    skippedDeletedSkills: ['debrute-example']
  };
  return {
    status: async () => status,
    sync: async () => sync
  };
}
