import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  architectureBoundaryViolations,
  architectureImportSpecifiers,
  architectureRuleKinds
} from '@debrute/architecture-rules';

const root = process.cwd();

describe('Debrute architecture boundaries', () => {
  it('keeps server internals out of the app protocol package', async () => {
    const protocol = await import('@debrute/app-protocol');
    expect('serviceError' in protocol).toBe(false);
  });

  it('keeps architecture checks structural instead of token denylist based', () => {
    expect(architectureRuleKinds()).toEqual(['imports', 'exports', 'package-json', 'tsconfig', 'vite-alias', 'public-barrel']);
  });

  it('keeps source boundaries in one shared rule set', async () => {
    expect(await architectureBoundaryViolations(root)).toEqual([]);
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

  it('keeps App Server project, Canvas Map, and Canvas ownership out of the coordinator', () => {
    for (const file of [
      'apps/app-server/src/project-session/projectSnapshot.ts',
      'apps/app-server/src/project-session/projectFileOperations.ts',
      'apps/app-server/src/project-session/projectHealth.ts',
      'apps/app-server/src/project-session/projectWatchEvents.ts',
      'apps/app-server/src/canvas-map/CanvasMapSessionService.ts',
      'apps/app-server/src/canvas/CanvasProjectionService.ts',
      'apps/app-server/src/canvas/CanvasSessionService.ts',
      'apps/app-server/src/project-documents/ProjectDocumentRegistry.ts',
      'apps/app-server/src/project-documents/ProjectDocumentTransaction.ts',
      'apps/app-server/src/project-documents/ProjectDocumentDiagnostics.ts',
      'apps/app-server/src/project-documents/documentDescriptors.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('keeps structured project document writes behind project document transactions', () => {
    const structuredDocumentServices = [
      'apps/app-server/src/canvas-map/CanvasMapSessionService.ts',
      'apps/app-server/src/canvas/CanvasRegistryService.ts',
      'apps/app-server/src/canvas/CanvasSessionService.ts',
      'apps/app-server/src/canvas/CanvasFeedbackService.ts',
      'apps/app-server/src/generated-assets/GeneratedAssetMetadataService.ts'
    ];
    const text = structuredDocumentServices.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(text).not.toContain('stageFileAtomicText');
    expect(text).not.toContain('writeInternalCanvasMapTextFile');
    expect(text).not.toContain('writeJsonAtomic');
    expect(text).not.toContain('writeFile(');
  });

  it('keeps integration command execution out of backend detection exports', () => {
    const text = readFileSync(join(root, 'apps/app-server/src/integrations/IntegrationBackends.ts'), 'utf8');

    expect(text).not.toContain("export { runIntegrationCommand");
    expect(text).not.toContain('IntegrationCommandInput');
    expect(text).not.toContain('IntegrationCommandResult');
  });

  it('keeps Workbench state helpers and shell views out of the web composition root', () => {
    for (const file of [
      'apps/web/src/workbench/services/projectSessionState.ts',
      'apps/web/src/workbench/services/appServerEvents.ts',
      'apps/web/src/workbench/services/canvasState.ts',
      'apps/web/src/workbench/services/textEditorWindows.ts',
      'apps/web/src/workbench/services/textFileBufferActions.ts',
      'apps/web/src/workbench/services/workbenchContextMenuCommands.ts',
      'apps/web/src/workbench/shell/NotificationStack.tsx',
      'apps/web/src/workbench/shell/FloatingDock.tsx',
      'apps/web/src/workbench/shell/FloatingPanel.tsx',
      'apps/web/src/workbench/shell/FloatingTextEditorWindow.tsx',
      'apps/web/src/workbench/shell/Inspector.tsx',
      'apps/web/src/workbench/shell/workbenchLayers.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }
  });

  it('keeps Electron main as a runtime supervisor and client', () => {
    for (const file of [
      'apps/desktop/src/electron/preload.ts'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(true);
    }

    const text = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');
    const specifiers = architectureImportSpecifiers('apps/desktop/src/electron/main.ts', text);

    expect(specifiers).not.toContain('@debrute/daemon');
    expect(specifiers).not.toContain('@debrute/app-server');
    expect(text).toContain('RuntimeSupervisor');
    expect(text).toContain('TrayController');
    expect(text).not.toContain('createDebruteDaemonHttpServer');
    expect(text).not.toContain("../../../web/dist");
    expect(text).not.toContain('registerWorkbenchIpc');
    expect(text).not.toContain('registerProjectFileProtocols');
  });

  it('keeps desktop package dependencies out of runtime server packages', () => {
    const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const desktopTsconfigs = [
      'apps/desktop/tsconfig.json',
      'apps/desktop/tsconfig.electron.json'
    ].map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty('@debrute/daemon');
    expect(desktopPackage.dependencies ?? {}).not.toHaveProperty('@debrute/app-server');
    expect(desktopTsconfigs).not.toContain('../../apps/daemon');
    expect(desktopTsconfigs).not.toContain('../../apps/app-server');
  });

  it('keeps CLI package dependencies out of runtime server packages', () => {
    const cliPackage = JSON.parse(readFileSync(join(root, 'apps/debrute-cli/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const cliTsconfig = readFileSync(join(root, 'apps/debrute-cli/tsconfig.json'), 'utf8');

    expect(cliPackage.dependencies ?? {}).not.toHaveProperty('@debrute/daemon');
    expect(cliPackage.dependencies ?? {}).not.toHaveProperty('@debrute/app-server');
    expect(cliTsconfig).not.toContain('../../apps/daemon');
    expect(cliTsconfig).not.toContain('../../apps/app-server');
  });

  it('keeps runtime host dependencies limited to the packages it imports', () => {
    const runtimeHostPackage = JSON.parse(readFileSync(join(root, 'apps/runtime-host/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(runtimeHostPackage.dependencies ?? {}).toHaveProperty('@debrute/daemon');
    expect(runtimeHostPackage.dependencies ?? {}).not.toHaveProperty('@debrute/workbench-runtime');
  });

  it('keeps daemon project session registry behind the daemon HTTP boundary', () => {
    expect(existsSync(join(root, 'apps/daemon/src/http/ProjectSessionRegistry.ts'))).toBe(true);

    const webClient = readFileSync(join(root, 'apps/web/src/api/httpWorkbenchApiClient.ts'), 'utf8');
    const desktopMain = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(webClient).not.toContain('ProjectSessionRegistry');
    expect(desktopMain).not.toContain('ProjectSessionRegistry');
  });

  it('allows apps to depend on the shared Workbench runtime registry package', () => {
    const cliPackage = readFileSync(join(root, 'apps/debrute-cli/package.json'), 'utf8');
    const desktopPackage = readFileSync(join(root, 'apps/desktop/package.json'), 'utf8');

    expect(cliPackage).toContain('"@debrute/workbench-runtime"');
    expect(desktopPackage).toContain('"@debrute/workbench-runtime"');
  });

  it('cleans generated output from the shared Workbench runtime package', () => {
    const cleanScript = readFileSync(join(root, 'scripts/clean.mjs'), 'utf8');

    expect(cleanScript).toContain("'packages/workbench-runtime/dist'");
  });

  it('keeps the Workbench runtime package out of app-specific launch ownership', () => {
    const files = execFileSync('rg', ['--files', 'packages/workbench-runtime/src'], {
      cwd: root,
      encoding: 'utf8'
    }).trim().split('\n');
    const text = files.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(text).not.toContain('@debrute/daemon');
    expect(text).not.toContain('electron');
    expect(text).not.toContain('@debrute/app-server');
    expect(text).not.toContain('spawn(');
  });

  it('keeps workbench runtime bearer tokens out of child argv and environment', () => {
    const launcherFiles = [
      'apps/debrute-cli/src/workbench/workbenchRuntimeLauncher.ts',
      'apps/debrute-cli/src/workbench/internalWorkbenchRuntimeChild.ts',
      'scripts/dev-workbench.ts'
    ];
    const text = launcherFiles.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');

    expect(text).not.toContain("'--token'");
    expect(text).not.toContain('DEBRUTE_DAEMON_TOKEN: token');
    expect(text).not.toContain('DEBRUTE_WORKBENCH_RUNTIME_TOKEN: token');
  });


  it('keeps daemon global runtime routes out of project App Server sessions', () => {
    const text = readFileSync(join(root, 'apps/daemon/src/http/createDebruteDaemonHttpServer.ts'), 'utf8');

    expect(text).toContain('DebruteGlobalRuntimeServer');
    expect(text).toContain('/api/cli/run');
    expect(text).toContain('runDaemonCliCommand');
    expect(text).not.toContain('runtimeAppServer');
  });

  it('keeps project App Server sessions free of global runtime forwarding methods', () => {
    const text = readFileSync(join(root, 'apps/app-server/src/server/DebruteAppServer.ts'), 'utf8');

    expect(text).not.toContain('getGlobalRuntime');
    for (const method of [
      'llmGetSettings',
      'llmSaveProviderSetting',
      'llmDeleteProviderSetting',
      'llmSetDefaultModelKey',
      'llmDiscoverProviderModels',
      'imageModelGetSettings',
      'imageModelSaveSetting',
      'videoModelGetSettings',
      'videoModelSaveSetting',
      'integrationsListStatus',
      'integrationsRescan'
    ]) {
      expect(text).not.toContain(`async ${method}(`);
    }
  });

  it('does not keep stale optional project-open result guards in the Web workbench', () => {
    const text = readFileSync(join(root, 'apps/web/src/workbench/WorkbenchApp.tsx'), 'utf8');

    expect(text).not.toContain('if (!opened)');
    expect(text).not.toContain('opened?.');
  });

  it('keeps Electron multi-window project ownership in the daemon', () => {
    const text = readFileSync(join(root, 'apps/desktop/src/electron/main.ts'), 'utf8');

    expect(text).toContain('registerElectronProjectWindow');
    expect(text).toContain('requireRuntimeClient().registerElectronProjectWindow');
    expect(text).not.toContain('nativeShell: createElectronNativeShell(shell)');
    expect(text).not.toContain('appServer.openProject');
    expect(text).not.toContain('appServer.getSnapshot');
  });

  it('exposes Electron project-window leases only through daemon HTTP routes', () => {
    const text = readFileSync(join(root, 'apps/daemon/src/http/createDebruteDaemonHttpServer.ts'), 'utf8');

    expect(text).toContain("'/electron-windows/'");
    expect(text).not.toContain('registerElectronProjectWindow(projectId');
    expect(text).not.toContain('registerElectronProjectWindow:');
  });

  it('keeps generated TypeScript output out of source directories', () => {
    for (const file of [
      'packages/canvas-map-core/src/index.js',
      'packages/canvas-map-core/src/index.js.map',
      'packages/canvas-map-core/src/index.d.ts',
      'packages/canvas-map-core/src/index.d.ts.map',
      'apps/daemon/src/index.js',
      'apps/daemon/src/index.js.map',
      'apps/daemon/src/index.d.ts',
      'apps/daemon/src/index.d.ts.map',
      'apps/daemon/src/http/createDebruteDaemonHttpServer.js',
      'apps/daemon/src/http/createDebruteDaemonHttpServer.js.map',
      'apps/daemon/src/http/createDebruteDaemonHttpServer.d.ts',
      'apps/daemon/src/http/createDebruteDaemonHttpServer.d.ts.map'
    ]) {
      expect(existsSync(join(root, file)), file).toBe(false);
    }
  });
});
