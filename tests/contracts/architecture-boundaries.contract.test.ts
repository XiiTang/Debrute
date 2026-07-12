import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  architectureBoundaryViolations,
  architectureImportSpecifiers,
  architectureRuleKinds
} from '@debrute/architecture-rules';

describe('Debrute architecture boundaries', () => {
  it('keeps server internals out of the app protocol package', async () => {
    const protocol = await import('@debrute/app-protocol');
    expect('serviceError' in protocol).toBe(false);
  });

  it('keeps architecture checks structural instead of token denylist based', () => {
    expect(architectureRuleKinds()).toEqual(['imports', 'exports', 'package-json', 'tsconfig', 'vite-alias', 'public-barrel']);
  });

  it('resolves relative imports before applying source boundary rules', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-relative-imports-'));
    try {
      mkdirSync(join(fixtureRoot, 'packages/project-core/src'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/electron/ipc'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'apps/debrute-cli/src/commands'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'packages/project-core/src/violates-package-boundary.ts'),
        "import '../../../apps/app-server/src/index.js';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/electron/ipc/violates-electron-boundary.ts'),
        "import '../../../../../apps/web/src/workbench/WorkbenchApp.js';\n",
        'utf8'
      );
      mkdirSync(join(fixtureRoot, 'apps/web/src/workbench'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/web/src/workbench/violates-renderer-app-server-boundary.ts'),
        "import '../../../../apps/app-server/src/index.js';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/debrute-cli/src/commands/violates-cli-package-boundary.ts'),
        "import '../../../../packages/project-core/src/index.js';\n",
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'packages/project-core/src/violates-package-boundary.ts',
        'apps/desktop/src/electron/ipc/violates-electron-boundary.ts',
        'apps/web/src/workbench/violates-renderer-app-server-boundary.ts',
        'apps/debrute-cli/src/commands/violates-cli-package-boundary.ts'
      ])).resolves.toEqual([
        'packages do not import apps: packages/project-core/src/violates-package-boundary.ts imports "apps/app-server/src/index.js"',
        'desktop electron stays a supervisor and client: apps/desktop/src/electron/ipc/violates-electron-boundary.ts imports "apps/web/src/workbench/WorkbenchApp.js"',
        'web workbench does not import app-server: apps/web/src/workbench/violates-renderer-app-server-boundary.ts imports "apps/app-server/src/index.js"',
        'cli stays behind app-server and protocol boundaries: apps/debrute-cli/src/commands/violates-cli-package-boundary.ts imports "packages/project-core/src/index.js"'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps runtime model config entries out of app-protocol', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-protocol-exports-'));
    try {
      mkdirSync(join(fixtureRoot, 'packages/app-protocol/src'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'packages/app-protocol/src/index.ts'),
        [
          'export interface ImageModelConfig {}',
          'export interface VideoModelConfig {}'
        ].join('\n'),
        'utf8'
      );
      await expect(architectureBoundaryViolations(fixtureRoot, ['packages/app-protocol/src/index.ts'])).resolves.toEqual([
        'app-protocol does not export runtime-owned config entries: packages/app-protocol/src/index.ts exports ImageModelConfig',
        'app-protocol does not export runtime-owned config entries: packages/app-protocol/src/index.ts exports VideoModelConfig'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps protocol, App Server, and runtime imports in the intended direction', () => {
    expect(architectureImportSpecifiers(
      'apps/web/src/workbench/example.ts',
      "import type { ProjectSessionSnapshot } from '@debrute/app-protocol';\n"
    )).toEqual(['@debrute/app-protocol']);
  });

  it('keeps Electron out of web tests while allowing source inspection helpers', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-web-tests-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/web/src/workbench'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/web/src/workbench/reads-source.test.ts'),
        "import { readFileSync } from 'node:fs';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/web/src/workbench/violates-electron.test.ts'),
        "import { ipcRenderer } from 'electron';\n",
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/web/src/workbench/reads-source.test.ts',
        'apps/web/src/workbench/violates-electron.test.ts'
      ])).resolves.toEqual([
        'web workbench does not import electron: apps/web/src/workbench/violates-electron.test.ts imports "electron"'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps backend, runtime-host, domain core, renderer, and capability packages out of Electron boundaries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-electron-domain-core-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/electron'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/electron/violates-domain-core-boundary.ts'),
        [
          "import { projectCacheKey } from '@debrute/project-core/projectCacheKeys';",
          "import '../../../../packages/capability-runtime/src/index.js';",
          "import 'react/jsx-runtime';"
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/package.json'),
        JSON.stringify({
          dependencies: {
            '@debrute/app-protocol': 'workspace:*',
            '@debrute/runtime-host': 'workspace:*',
            '@debrute/project-core': 'workspace:*',
            '@debrute/canvas-core': 'workspace:*',
            '@debrute/capability-core': 'workspace:*',
            '@debrute/capability-runtime': 'workspace:*',
            '@debrute/web': 'workspace:*',
            '@debrute/workbench-runtime': 'workspace:*'
          },
          devDependencies: {
            react: '^19.0.0'
          }
        }, null, 2),
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/tsconfig.json'),
        JSON.stringify({
          references: [
            { path: '../../packages/app-protocol' },
            { path: '../../apps/runtime-host' },
            { path: '../../packages/project-core' },
            { path: '../../packages/canvas-core' },
            { path: '../../packages/capability-runtime' },
            { path: '../../packages/workbench-runtime' }
          ]
        }, null, 2),
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/tsconfig.electron.json'),
        JSON.stringify({
          references: [
            { path: '../../packages/app-protocol' },
            { path: '../../packages/canvas-map-core' },
            { path: '../../packages/workbench-runtime' }
          ]
        }, null, 2),
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/desktop/src/electron/violates-domain-core-boundary.ts',
        'apps/desktop/package.json',
        'apps/desktop/tsconfig.json',
        'apps/desktop/tsconfig.electron.json'
      ])).resolves.toEqual([
        'desktop electron stays a supervisor and client: apps/desktop/src/electron/violates-domain-core-boundary.ts imports "@debrute/project-core/projectCacheKeys"',
        'desktop electron stays a supervisor and client: apps/desktop/src/electron/violates-domain-core-boundary.ts imports "packages/capability-runtime/src/index.js"',
        'desktop electron stays a supervisor and client: apps/desktop/src/electron/violates-domain-core-boundary.ts imports "react/jsx-runtime"',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/runtime-host in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/project-core in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/canvas-core in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/capability-core in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/capability-runtime in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/web in dependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares react in devDependencies',
        'desktop electron stays a supervisor and client: apps/desktop/tsconfig.json references ../../apps/runtime-host',
        'desktop electron stays a supervisor and client: apps/desktop/tsconfig.json references ../../packages/capability-runtime',
        'desktop electron stays a supervisor and client: apps/desktop/tsconfig.json references ../../packages/project-core',
        'desktop electron stays a supervisor and client: apps/desktop/tsconfig.json references ../../packages/canvas-core',
        'desktop electron stays a supervisor and client: apps/desktop/tsconfig.electron.json references ../../packages/canvas-map-core'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps forbidden Electron packages out of every dependency metadata section', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-electron-dependency-sections-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/desktop'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/package.json'),
        JSON.stringify({
          devDependencies: {
            '@debrute/project-core': 'workspace:*'
          },
          optionalDependencies: {
            '@debrute/web': 'workspace:*'
          },
          peerDependencies: {
            react: '^19.0.0'
          }
        }, null, 2),
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/desktop/package.json'
      ])).resolves.toEqual([
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/project-core in devDependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares @debrute/web in optionalDependencies',
        'desktop electron stays a supervisor and client: apps/desktop/package.json declares react in peerDependencies'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps CLI manifests and build references behind public boundaries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-cli-manifest-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/debrute-cli'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/debrute-cli/package.json'),
        JSON.stringify({
          dependencies: { '@debrute/daemon': 'workspace:*' },
          devDependencies: { '@debrute/app-server': 'workspace:*' }
        }),
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/debrute-cli/tsconfig.json'),
        JSON.stringify({
          references: [
            { path: '../../apps/daemon' },
            { path: '../../apps/app-server' }
          ]
        }),
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/debrute-cli/package.json',
        'apps/debrute-cli/tsconfig.json'
      ])).resolves.toEqual([
        'cli stays behind app-server and protocol boundaries: apps/debrute-cli/package.json declares @debrute/daemon in dependencies',
        'cli stays behind app-server and protocol boundaries: apps/debrute-cli/package.json declares @debrute/app-server in devDependencies',
        'cli stays behind app-server and protocol boundaries: apps/debrute-cli/tsconfig.json references ../../apps/daemon',
        'cli stays behind app-server and protocol boundaries: apps/debrute-cli/tsconfig.json references ../../apps/app-server'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

});
