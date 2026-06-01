import { describe, expect, it } from 'vitest';
import type { AxisAppServer } from '@axis/app-server';
import type {
  AxisSkillsSyncService,
  SkillsStatusSnapshot,
  SkillsSyncSnapshot
} from '@axis/capability-runtime';
import { parseAxisArgs } from '../src/parser/parseAxisArgs';
import { runRuntimeCommand } from '../src/commands/runtimeCommands';
import { resolveCliAxisVersion } from '../src/runtime/createCliSkillsRuntime';

describe('axis skills CLI commands', () => {
  it('parses skills sync with --force as a boolean option', () => {
    const parsed = parseAxisArgs(['skills', 'sync', '--force']);

    expect(parsed.command).toBe('skills.sync');
    expect(parsed.options.force).toBe('true');
  });

  it('renders skills status records from the sync service', async () => {
    const result = await runRuntimeCommand(parseAxisArgs(['skills', 'status']), {
      skillsService: fakeSkillsService()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'skills.status',
      fields: {
        skills: 1,
        diagnostics: 0,
        source_root: '/home/user/.agents/skills',
        state_path: '/home/user/.axis/skills-state.json',
        axis_version: '1.2.3',
        outdated_state: false
      }
    });
    expect(result.records).toContainEqual(expect.objectContaining({
      name: 'skill',
      fields: expect.objectContaining({ name: 'axis-core' })
    }));
  });

  it('renders sync updated and skipped records', async () => {
    const result = await runRuntimeCommand(parseAxisArgs(['skills', 'sync', '--force']), {
      skillsService: fakeSkillsService()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'skills.sync',
      fields: {
        updated: 1,
        skipped: 1,
        force: true
      }
    });
    expect(result.records).toContainEqual(expect.objectContaining({ name: 'updated_skill' }));
    expect(result.records).toContainEqual(expect.objectContaining({ name: 'skipped_skill' }));
  });

  it('adds CLI-owned Skills status to runtime status output', async () => {
    const result = await runRuntimeCommand(parseAxisArgs(['runtime', 'status']), {
      server: {
        runtimeStatusForCli: async () => ({
          ok: true,
          imageModels: 2,
          availableImageModels: 1,
          videoModels: 1,
          availableVideoModels: 1,
          availableLlmModels: 1,
          diagnostics: 0
        })
      } as unknown as AxisAppServer,
      skillsService: fakeSkillsService()
    });

    expect(result).toMatchObject({
      status: 'ok',
      command: 'runtime.status',
      fields: {
        image_models: 2,
        available_image_models: 1,
        skills: 1,
        diagnostics: 0
      }
    });
  });

  it('adds CLI-owned Skills diagnostics to runtime doctor output', async () => {
    const result = await runRuntimeCommand(parseAxisArgs(['runtime', 'doctor']), {
      server: {
        runtimeDoctorForCli: async () => ({
          diagnostics: [{
            severity: 'warning',
            code: 'llm_model_not_configured',
            message: 'No available LLM model is configured.'
          }]
        })
      } as unknown as AxisAppServer,
      skillsService: fakeSkillsService({
        skills: [],
        bundledSkillsRoot: undefined,
        bundledRootAvailable: false,
        diagnostics: [{
          source: 'axis-sync',
          root: '/AXIS/skills',
          code: 'skills_bundle_unavailable',
          message: 'Bundled AXIS Skills are unavailable.'
        }]
      })
    });

    expect(result.status).toBe('ok');
    expect(result.fields).toEqual({ diagnostics: 3 });
    expect(result.records?.map((record) => record.fields.code)).toEqual([
      'llm_model_not_configured',
      'skills_bundle_unavailable',
      'skills_not_installed'
    ]);
  });

  it('fails version resolution when package metadata is unavailable', async () => {
    await expect(resolveCliAxisVersion('/tmp/axis-cli-without-package/dist')).rejects.toThrow(/package metadata/i);
  });
});

function fakeSkillsService(overrides: Partial<SkillsStatusSnapshot> = {}): AxisSkillsSyncService {
  const status: SkillsStatusSnapshot = {
    sources: [{ source: 'shared-agents', root: '/home/user/.agents/skills' }],
    skills: [{
      name: 'axis-core',
      description: 'Core',
      source: 'shared-agents',
      root: '/home/user/.agents/skills',
      skillDir: '/home/user/.agents/skills/axis-core',
      skillPath: '/home/user/.agents/skills/axis-core/SKILL.md',
      axisVersion: '1.2.3'
    }],
    diagnostics: [],
    statePath: '/home/user/.axis/skills-state.json',
    stateVersion: 1,
    currentAxisVersion: '1.2.3',
    sharedSkillsRoot: '/home/user/.agents/skills',
    bundledSkillsRoot: '/AXIS/skills',
    bundledRootAvailable: true,
    bundledSkills: ['axis-core', 'axis-image-director'],
    missingBundledSkillCount: 1,
    outdatedState: false,
    ...overrides
  };
  const sync: SkillsSyncSnapshot = {
    ...status,
    force: true,
    updatedSkills: status.skills,
    skippedSkills: ['axis-image-director']
  };
  return {
    status: async () => status,
    sync: async () => sync
  };
}
