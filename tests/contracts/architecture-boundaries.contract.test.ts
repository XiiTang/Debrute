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
    expect(architectureRuleKinds()).toEqual(['imports', 'package-json', 'tsconfig', 'vite-alias']);
  });

  it('resolves relative imports before applying source boundary rules', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-relative-imports-'));
    try {
      mkdirSync(join(fixtureRoot, 'packages/canvas-core/src'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/electron/ipc'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'packages/canvas-core/src/violates-package-boundary.ts'),
        "import '../../../apps/desktop/src/electron/main.js';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/electron/ipc/violates-electron-boundary.ts'),
        "import '../../../../../apps/web/src/workbench/WorkbenchApp.js';\n",
        'utf8'
      );
      await expect(architectureBoundaryViolations(fixtureRoot, [
        'packages/canvas-core/src/violates-package-boundary.ts',
        'apps/desktop/src/electron/ipc/violates-electron-boundary.ts'
      ])).resolves.toEqual([
        'packages do not import apps: packages/canvas-core/src/violates-package-boundary.ts imports "apps/desktop/src/electron/main.js"',
        'desktop electron stays a native host and client: apps/desktop/src/electron/ipc/violates-electron-boundary.ts imports "apps/web/src/workbench/WorkbenchApp.js"'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps protocol and Runtime imports in the intended direction', () => {
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

  it('keeps domain core and renderer packages out of Electron boundaries', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-electron-domain-core-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/electron'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/electron/violates-domain-core-boundary.ts'),
        [
          "import type { CanvasDocument } from '@debrute/canvas-core';",
          "import 'react/jsx-runtime';"
        ].join('\n'),
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/package.json'),
        JSON.stringify({
          dependencies: {
            '@debrute/app-protocol': 'workspace:*',
            '@debrute/canvas-core': 'workspace:*',
            '@debrute/web': 'workspace:*',
            '@debrute/runtime-control-client': 'workspace:*'
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
            { path: '../../packages/canvas-core' },
            { path: '../../apps/web' }
          ]
        }, null, 2),
        'utf8'
      );
      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/desktop/src/electron/violates-domain-core-boundary.ts',
        'apps/desktop/package.json',
        'apps/desktop/tsconfig.json'
      ])).resolves.toEqual([
        'desktop electron stays a native host and client: apps/desktop/src/electron/violates-domain-core-boundary.ts imports "@debrute/canvas-core"',
        'desktop electron stays a native host and client: apps/desktop/src/electron/violates-domain-core-boundary.ts imports "react/jsx-runtime"',
        'desktop electron stays a native host and client: apps/desktop/package.json declares @debrute/canvas-core in dependencies',
        'desktop electron stays a native host and client: apps/desktop/package.json declares @debrute/web in dependencies',
        'desktop electron stays a native host and client: apps/desktop/package.json declares react in devDependencies',
        'desktop electron stays a native host and client: apps/desktop/tsconfig.json references ../../packages/canvas-core',
        'desktop electron stays a native host and client: apps/desktop/tsconfig.json references ../../apps/web'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps unowned UI dependencies and imports out of the Web Workbench', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'debrute-architecture-web-ui-'));
    try {
      mkdirSync(join(fixtureRoot, 'apps/web/src/workbench/settings'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/web/src/workbench/settings/violates-ui-boundary.tsx'),
        "import { Button } from '@mui/material';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/web/package.json'),
        JSON.stringify({ dependencies: { tailwindcss: '^4.0.0' } }, null, 2),
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'apps/web/src/workbench/settings/violates-ui-boundary.tsx',
        'apps/web/package.json'
      ])).resolves.toEqual([
        'web features use the owned Workbench UI surface: apps/web/src/workbench/settings/violates-ui-boundary.tsx imports "@mui/material"',
        'web package uses the owned Workbench UI surface: apps/web/package.json declares tailwindcss in dependencies'
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
            '@debrute/canvas-core': 'workspace:*'
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
        'desktop electron stays a native host and client: apps/desktop/package.json declares @debrute/canvas-core in devDependencies',
        'desktop electron stays a native host and client: apps/desktop/package.json declares @debrute/web in optionalDependencies',
        'desktop electron stays a native host and client: apps/desktop/package.json declares react in peerDependencies'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

});
