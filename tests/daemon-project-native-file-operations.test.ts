import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectSessionSnapshot } from '@debrute/app-protocol';
import {
  copyProjectAbsolutePaths,
  revealProjectPathInSystemFileManager,
  trashProjectPathsWithNativeShell
} from '../apps/daemon/src/http/projectNativeFileOperations';

describe('daemon project native file operations', () => {
  it('returns validated absolute paths for Copy Path batches', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-copy-path-batch-'));
    try {
      await mkdir(join(projectRoot, 'briefs'), { recursive: true });
      await writeFile(join(projectRoot, 'briefs/outline.md'), '# Outline', 'utf8');
      await writeFile(join(projectRoot, 'cover.png'), 'cover', 'utf8');
      const canonicalRoot = await realpath(projectRoot);

      await expect(copyProjectAbsolutePaths({
        projectRoot,
        entries: [
          { projectRelativePath: 'briefs/outline.md', kind: 'file' },
          { projectRelativePath: 'cover.png', kind: 'file' }
        ]
      })).resolves.toEqual({
        paths: [
          join(canonicalRoot, 'briefs/outline.md'),
          join(canonicalRoot, 'cover.png')
        ]
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlink escapes before exposing absolute paths', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-native-symlink-'));
    const outside = join(tmpdir(), `debrute-native-outside-${Date.now()}.txt`);
    try {
      await writeFile(outside, 'outside', 'utf8');
      await symlink(outside, join(projectRoot, 'linked.txt'));

      await expect(copyProjectAbsolutePaths({
        projectRoot,
        entries: [{ projectRelativePath: 'linked.txt', kind: 'file' }]
      })).rejects.toThrow('escapes project root through a symlink');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  });

  it('checks target kind before native shell operations', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-native-kind-'));
    try {
      await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
      const shell = nativeShellFixture();

      await expect(revealProjectPathInSystemFileManager({
        projectRoot,
        projectRelativePath: 'brief.md',
        kind: 'directory',
        nativeShell: shell
      })).rejects.toThrow('Resolved project path is not a directory.');

      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(shell.openPath).not.toHaveBeenCalled();
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('reveals files and directories after validation', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-native-reveal-'));
    try {
      await mkdir(join(projectRoot, 'assets'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/cover.png'), 'cover', 'utf8');
      const shell = nativeShellFixture();
      const canonicalRoot = await realpath(projectRoot);

      await revealProjectPathInSystemFileManager({
        projectRoot,
        projectRelativePath: 'assets/cover.png',
        kind: 'file',
        nativeShell: shell
      });
      await revealProjectPathInSystemFileManager({
        projectRoot,
        projectRelativePath: 'assets',
        kind: 'directory',
        nativeShell: shell
      });

      expect(shell.showItemInFolder).toHaveBeenCalledWith(join(canonicalRoot, 'assets/cover.png'));
      expect(shell.openPath).toHaveBeenCalledWith(join(canonicalRoot, 'assets'));
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('trashes path batches after validation and refreshes once', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'debrute-native-trash-batch-'));
    try {
      await mkdir(join(projectRoot, 'assets/pages'), { recursive: true });
      await writeFile(join(projectRoot, 'assets/pages/page.png'), 'page', 'utf8');
      await writeFile(join(projectRoot, 'brief.md'), '# Brief', 'utf8');
      const shell = nativeShellFixture();
      let refreshCount = 0;
      const refreshedSnapshot: ProjectSessionSnapshot = {
        projectRoot,
        metadata: {
          schemaVersion: 1,
          name: 'Test Project'
        },
        files: [],
        canvases: [],
        projections: [],
        diagnostics: [],
        health: {
          projectName: 'Test Project',
          canvasCount: 0,
          diagnosticCounts: {
            errors: 0,
            warnings: 0,
            infos: 0
          },
          runtimeDataLocation: 'debrute-home',
          checkedAt: '2026-06-06T00:00:00.000Z'
        }
      };

      await expect(trashProjectPathsWithNativeShell({
        projectRoot,
        entries: [
          { projectRelativePath: 'assets', kind: 'directory' },
          { projectRelativePath: 'assets/pages/page.png', kind: 'file' },
          { projectRelativePath: 'brief.md', kind: 'file' }
        ],
        nativeShell: shell,
        refreshProject: async () => {
          refreshCount += 1;
          return refreshedSnapshot;
        }
      })).resolves.toEqual({
        results: [
          { sourceProjectRelativePath: 'assets', projectRelativePath: 'assets', kind: 'directory', status: 'ok' },
          { sourceProjectRelativePath: 'brief.md', projectRelativePath: 'brief.md', kind: 'file', status: 'ok' }
        ],
        snapshot: refreshedSnapshot
      });

      expect(shell.trashItem).toHaveBeenCalledTimes(2);
      expect(refreshCount).toBe(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function nativeShellFixture() {
  return {
    platform: 'darwin' as NodeJS.Platform,
    showItemInFolder: vi.fn(async () => undefined),
    openPath: vi.fn(async () => undefined),
    trashItem: vi.fn(async () => undefined)
  };
}
