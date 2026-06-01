import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  architectureBoundaryViolations,
  architectureImportSpecifiers,
  architectureRuleKinds
} from '@axis/architecture-rules';

const root = process.cwd();

describe('AXIS architecture boundaries', () => {
  it('has a dedicated app protocol package for cross-app DTOs', async () => {
    const protocol = await import('@axis/app-protocol');
    expect(protocol.APP_PROTOCOL_SCHEMA_VERSION).toBe(1);
    expect('serviceError' in protocol).toBe(false);
  });

  it('keeps architecture checks structural instead of token denylist based', () => {
    expect(architectureRuleKinds()).toEqual(['imports', 'exports', 'package-json', 'tsconfig', 'vite-alias', 'public-barrel']);
  });

  it('keeps source boundaries in one shared rule set', async () => {
    expect(await architectureBoundaryViolations(root)).toEqual([]);
  });

  it('resolves relative imports before applying source boundary rules', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'axis-architecture-relative-imports-'));
    try {
      mkdirSync(join(fixtureRoot, 'packages/project-core/src'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/electron/ipc'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'apps/axis-cli/src/commands'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'packages/project-core/src/violates-package-boundary.ts'),
        "import '../../../apps/app-server/src/index.js';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/electron/ipc/violates-electron-boundary.ts'),
        "import '../../workbench/WorkbenchApp.js';\n",
        'utf8'
      );
      mkdirSync(join(fixtureRoot, 'apps/desktop/src/workbench'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, 'apps/desktop/src/workbench/violates-renderer-app-server-boundary.ts'),
        "import '../../../app-server/src/index.js';\n",
        'utf8'
      );
      writeFileSync(
        join(fixtureRoot, 'apps/axis-cli/src/commands/violates-cli-package-boundary.ts'),
        "import '../../../../packages/project-core/src/index.js';\n",
        'utf8'
      );

      await expect(architectureBoundaryViolations(fixtureRoot, [
        'packages/project-core/src/violates-package-boundary.ts',
        'apps/desktop/src/electron/ipc/violates-electron-boundary.ts',
        'apps/desktop/src/workbench/violates-renderer-app-server-boundary.ts',
        'apps/axis-cli/src/commands/violates-cli-package-boundary.ts'
      ])).resolves.toEqual([
        'packages do not import apps: packages/project-core/src/violates-package-boundary.ts imports "apps/app-server/src/index.js"',
        'desktop electron does not import workbench renderer internals: apps/desktop/src/electron/ipc/violates-electron-boundary.ts imports "apps/desktop/src/workbench/WorkbenchApp.js"',
        'desktop renderer does not import app-server: apps/desktop/src/workbench/violates-renderer-app-server-boundary.ts imports "apps/app-server/src/index.js"',
        'cli stays behind app-server and protocol boundaries: apps/axis-cli/src/commands/violates-cli-package-boundary.ts imports "packages/project-core/src/index.js"'
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps runtime model config entries out of app-protocol', async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'axis-architecture-protocol-exports-'));
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
      'apps/desktop/src/workbench/example.ts',
      "import type { ProjectSessionSnapshot } from '@axis/app-protocol';\n"
    )).toEqual(['@axis/app-protocol']);
  });

  it('keeps App Server project, Flowmap, and Canvas ownership out of the coordinator', () => {
    for (const file of [
      'apps/app-server/src/project-session/projectSnapshot.ts',
      'apps/app-server/src/project-session/projectFileOperations.ts',
      'apps/app-server/src/project-session/projectHealth.ts',
      'apps/app-server/src/project-session/projectWatchEvents.ts',
      'apps/app-server/src/flowmap/FlowmapSessionService.ts',
      'apps/app-server/src/canvas/CanvasProjectionService.ts',
      'apps/app-server/src/canvas/CanvasSessionService.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('keeps Workbench state helpers and shell views out of the renderer composition root', () => {
    for (const file of [
      'apps/desktop/src/workbench/services/projectSessionState.ts',
      'apps/desktop/src/workbench/services/hotExitRestore.ts',
      'apps/desktop/src/workbench/services/appServerEvents.ts',
      'apps/desktop/src/workbench/services/canvasState.ts',
      'apps/desktop/src/workbench/services/textEditorWindows.ts',
      'apps/desktop/src/workbench/services/textFileBufferActions.ts',
      'apps/desktop/src/workbench/services/workbenchContextMenuCommands.ts',
      'apps/desktop/src/workbench/shell/NotificationStack.tsx',
      'apps/desktop/src/workbench/shell/FloatingDock.tsx',
      'apps/desktop/src/workbench/shell/FloatingPanel.tsx',
      'apps/desktop/src/workbench/shell/FloatingTextEditorWindow.tsx',
      'apps/desktop/src/workbench/shell/Inspector.tsx',
      'apps/desktop/src/workbench/shell/workbenchLayers.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('keeps Electron main free of protocol, desktop-state, and Hot Exit request implementations', () => {
    for (const file of [
      'apps/desktop/src/electron/desktop-state/desktopStateStore.ts',
      'apps/desktop/src/electron/protocols/registerProjectProtocols.ts',
      'apps/desktop/src/electron/hot-exit/requestHotExitSnapshot.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }

    const text = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');
    expect(architectureImportSpecifiers('apps/desktop/src/electron/main.ts', text)).toContain('apps/desktop/src/electron/ipc/registerWorkbenchIpc.js');
  });

  it('keeps Flowmap source package output out of src', () => {
    expect(existsSync(join(root, 'packages/flowmap-core/src/index.js'))).toBe(false);
    expect(existsSync(join(root, 'packages/flowmap-core/src/index.js.map'))).toBe(false);
    expect(existsSync(join(root, 'packages/flowmap-core/src/index.d.ts'))).toBe(false);
    expect(existsSync(join(root, 'packages/flowmap-core/src/index.d.ts.map'))).toBe(false);
  });
});
