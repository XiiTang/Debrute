import { describe, expect, it } from 'vitest';
import type {
  AxisCliInstallResult,
  AxisCliManualCommand,
  AxisCliPathRepairResult,
  AxisCliSkillsStatus,
  AxisCliSkillsSyncResult,
  AxisCliStatus,
  AxisSkillsState,
  SkillsStatusSnapshot,
  SkillsSyncSnapshot
} from '@axis/app-protocol';

describe('Axis CLI protocol contracts', () => {
  it('models every Axis CLI status state used by Desktop Settings', () => {
    const skills: AxisCliSkillsStatus = { kind: 'partially_removed', skippedDeletedSkills: ['axis-example'] };
    const statuses: AxisCliStatus[] = [
      { kind: 'not_installed', desktopVersion: '0.2.0', manualCommand: 'curl ...' },
      {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.axis/bin/axis',
        resolvedPath: '/Users/me/.axis/bin/axis',
        onPath: true,
        skills: { kind: 'in_sync', axisVersion: '0.2.0' }
      },
      {
        kind: 'update_available',
        desktopVersion: '0.2.0',
        cliVersion: '0.1.0',
        managedPath: '/Users/me/.axis/bin/axis',
        skills: { kind: 'out_of_sync', cliVersion: '0.1.0', stateAxisVersion: '0.0.9' }
      },
      {
        kind: 'external_newer',
        desktopVersion: '0.2.0',
        cliVersion: '0.3.0',
        managedPath: '/Users/me/.axis/bin/axis',
        skills
      },
      {
        kind: 'installed_but_not_on_path',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.axis/bin/axis',
        repairCommand: 'export PATH="$HOME/.axis/bin:$PATH"',
        skills: { kind: 'in_sync', axisVersion: '0.2.0' }
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

  it('models Axis CLI action results without renderer-provided commands', () => {
    const install: AxisCliInstallResult = {
      ok: true,
      status: {
        kind: 'installed',
        desktopVersion: '0.2.0',
        cliVersion: '0.2.0',
        managedPath: '/Users/me/.axis/bin/axis',
        resolvedPath: '/Users/me/.axis/bin/axis',
        onPath: true,
        skills: { kind: 'in_sync', axisVersion: '0.2.0' }
      }
    };
    const sync: AxisCliSkillsSyncResult = {
      ok: true,
      status: { kind: 'in_sync', axisVersion: '0.2.0' }
    };
    const repair: AxisCliPathRepairResult = {
      ok: true,
      status: install.status
    };
    const manual: AxisCliManualCommand = {
      platform: 'macos',
      command: 'curl -L ... && ~/.axis/bin/axis skills sync'
    };

    expect(install.ok).toBe(true);
    expect(sync.status.kind).toBe('in_sync');
    expect(repair.status.kind).toBe('installed');
    expect(manual.command).toContain('axis skills sync');
  });

  it('models final Skills state and sync snapshots', () => {
    const state: AxisSkillsState = {
      schemaVersion: 1,
      axisVersion: '0.2.0',
      bundledSkills: ['axis-core', 'axis-image-director'],
      updatedSkills: ['axis-core'],
      addedBundledSkills: ['axis-image-director'],
      skippedDeletedSkills: ['axis-example'],
      diagnostics: [{
        code: 'skills_out_of_sync',
        severity: 'warning',
        message: 'AXIS Skills are out of sync.'
      }],
      updatedAt: '2026-06-04T00:00:00.000Z'
    };
    const status: SkillsStatusSnapshot = {
      sources: [{ source: 'shared-agents', root: '/Users/me/.agents/skills' }],
      skills: [],
      diagnostics: [],
      statePath: '/Users/me/.axis/skills-state.json',
      state,
      currentAxisVersion: '0.2.0',
      sharedSkillsRoot: '/Users/me/.agents/skills',
      bundledSkillsRoot: '/Axis/skills',
      bundledRootAvailable: true,
      bundledSkills: ['axis-core', 'axis-image-director'],
      missingBundledSkills: ['axis-example'],
      missingBundledSkillCount: 1,
      skippedDeletedSkills: ['axis-example']
    };
    const sync: SkillsSyncSnapshot = {
      ...status,
      force: false,
      updatedSkills: [],
      addedBundledSkills: [],
      skippedDeletedSkills: ['axis-example']
    };

    expect(sync.state?.diagnostics[0]?.severity).toBe('warning');
    expect(sync.skippedDeletedSkills).toEqual(['axis-example']);
  });
});
