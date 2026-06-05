import { describe, expect, it } from 'vitest';
import type {
  DebruteCliInstallResult,
  DebruteCliManualCommand,
  DebruteCliPathRepairResult,
  DebruteCliSkillsStatus,
  DebruteCliSkillsSyncResult,
  DebruteCliStatus,
  DebruteSkillsState,
  SkillsStatusSnapshot,
  SkillsSyncSnapshot
} from '@debrute/app-protocol';

describe('Debrute CLI protocol contracts', () => {
  it('models every Debrute CLI status state used by Desktop Settings', () => {
    const skills: DebruteCliSkillsStatus = { kind: 'partially_removed', skippedDeletedSkills: ['debrute-example'] };
    const statuses: DebruteCliStatus[] = [
      { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' },
      {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        resolvedPath: '/Users/me/.debrute/bin/debrute',
        onPath: true,
        skills: { kind: 'in_sync', debruteVersion: '0.2.0' }
      },
      {
        kind: 'update_available',
        desktopVersion: '0.2.0',
        cliVersion: '0.1.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        skills: { kind: 'out_of_sync', cliVersion: '0.1.0', stateDebruteVersion: '0.0.9' }
      },
      {
        kind: 'external_newer',
        desktopVersion: '0.2.0',
        cliVersion: '0.3.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        skills
      },
      {
        kind: 'installed_but_not_on_path',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        repairCommand: 'export PATH="$HOME/.debrute/bin:$PATH"',
        skills: { kind: 'in_sync', debruteVersion: '0.2.0' }
      },
      { kind: 'error', desktopVersion: '0.2.0', code: 'download_failed', message: 'download failed', manualCommand: 'curl ...' }
    ];

    expect(statuses.map((status) => status.kind)).toEqual([
      'not_installed',
      'installed',
      'update_available',
      'external_newer',
      'installed_but_not_on_path',
      'error'
    ]);
  });

  it('models Debrute CLI action results without renderer-provided commands', () => {
    const install: DebruteCliInstallResult = {
      ok: true,
      status: {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.debrute/bin/debrute',
        resolvedPath: '/Users/me/.debrute/bin/debrute',
        onPath: true,
        skills: { kind: 'in_sync', debruteVersion: '0.2.0' }
      }
    };
    const sync: DebruteCliSkillsSyncResult = {
      ok: true,
      status: { kind: 'in_sync', debruteVersion: '0.2.0' }
    };
    const repair: DebruteCliPathRepairResult = {
      ok: true,
      status: install.status
    };
    const manual: DebruteCliManualCommand = {
      platform: 'macos',
      command: 'curl -L ... && ~/.debrute/bin/debrute skills sync'
    };

    expect(install.ok).toBe(true);
    expect(sync.status.kind).toBe('in_sync');
    expect(repair.status.kind).toBe('installed');
    expect(manual.command).toContain('debrute skills sync');
  });

  it('models final Skills state and sync snapshots', () => {
    const state: DebruteSkillsState = {
      schemaVersion: 1,
      debruteVersion: '0.2.0',
      bundledSkills: ['debrute-core', 'debrute-image-director'],
      updatedSkills: ['debrute-core'],
      addedBundledSkills: ['debrute-image-director'],
      skippedDeletedSkills: ['debrute-example'],
      diagnostics: [{
        code: 'skills_out_of_sync',
        severity: 'warning',
        message: 'Debrute Skills are out of sync.'
      }],
      updatedAt: '2026-06-04T00:00:00.000Z'
    };
    const status: SkillsStatusSnapshot = {
      sources: [{ source: 'shared-agents', root: '/Users/me/.agents/skills' }],
      skills: [],
      diagnostics: [],
      statePath: '/Users/me/.debrute/skills-state.json',
      state,
      currentDebruteVersion: '0.2.0',
      sharedSkillsRoot: '/Users/me/.agents/skills',
      bundledSkillsRoot: '/Debrute/skills',
      bundledRootAvailable: true,
      bundledSkills: ['debrute-core', 'debrute-image-director'],
      missingBundledSkills: ['debrute-example'],
      missingBundledSkillCount: 1,
      skippedDeletedSkills: ['debrute-example']
    };
    const sync: SkillsSyncSnapshot = {
      ...status,
      force: false,
      updatedSkills: [],
      addedBundledSkills: [],
      skippedDeletedSkills: ['debrute-example']
    };

    expect(sync.state?.diagnostics[0]?.severity).toBe('warning');
    expect(sync.skippedDeletedSkills).toEqual(['debrute-example']);
  });
});
