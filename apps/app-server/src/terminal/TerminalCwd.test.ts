import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTerminalCwd } from './TerminalCwd.js';

describe('resolveTerminalCwd', { tags: ['terminal'] }, () => {
  const roots: string[] = [];

  afterEach(async () => {
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it('uses the project root for an empty cwd input', async () => {
    const projectRoot = await tempProjectRoot('terminal-cwd-root-');

    await expect(resolveTerminalCwd({ projectRoot })).resolves.toMatchObject({
      absolutePath: await realpath(projectRoot),
      projectRelativePath: ''
    });
  });

  it('uses an explicit directory input', async () => {
    const projectRoot = await tempProjectRoot('terminal-cwd-dir-');
    await mkdir(join(projectRoot, 'src'), { recursive: true });

    await expect(resolveTerminalCwd({
      projectRoot,
      cwdProjectRelativePath: 'src'
    })).resolves.toMatchObject({
      absolutePath: await realpath(join(projectRoot, 'src')),
      projectRelativePath: 'src'
    });
  });

  it('uses the parent directory for a file input', async () => {
    const projectRoot = await tempProjectRoot('terminal-cwd-file-');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(join(projectRoot, 'src/index.ts'), '', 'utf8');

    await expect(resolveTerminalCwd({
      projectRoot,
      cwdProjectRelativePath: 'src/index.ts'
    })).resolves.toMatchObject({
      absolutePath: await realpath(join(projectRoot, 'src')),
      projectRelativePath: 'src'
    });
  });

  it('rejects paths outside the project root', async () => {
    const projectRoot = await tempProjectRoot('terminal-cwd-escape-');

    await expect(resolveTerminalCwd({
      projectRoot,
      cwdProjectRelativePath: '../outside'
    })).rejects.toMatchObject({
      code: 'terminal_invalid_cwd'
    });
  });

  it('rejects symlinks escaping the project root', async () => {
    const projectRoot = await tempProjectRoot('terminal-cwd-symlink-');
    const outsideRoot = await tempProjectRoot('terminal-cwd-outside-');
    await symlink(outsideRoot, join(projectRoot, 'outside'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(resolveTerminalCwd({
      projectRoot,
      cwdProjectRelativePath: 'outside'
    })).rejects.toMatchObject({
      code: 'terminal_invalid_cwd'
    });
  });

  async function tempProjectRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
  }
});
