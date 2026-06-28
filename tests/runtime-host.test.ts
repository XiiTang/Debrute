import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseRuntimeHostConfig } from '../apps/runtime-host/src/runtimeHostConfig';

describe('@debrute/runtime-host config', () => {
  it('parses only the environment needed to start the runtime host', () => {
    const config = parseRuntimeHostConfig({
      env: {
        DEBRUTE_RUNTIME_HOST_DAEMON_PORT: '17321',
        DEBRUTE_RUNTIME_HOST_TOKEN_FILE: '/tmp/debrute-token',
        DEBRUTE_RUNTIME_HOST_WEB_DIST_DIR: '/Applications/Debrute.app/Contents/Resources/app.asar/dist',
        DEBRUTE_RUNTIME_HOST_PRODUCT_VERSION: '0.2.0',
        DEBRUTE_RUNTIME_HOST_CLI_PAYLOAD_DIR: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/cli',
        DEBRUTE_RUNTIME_HOST_SKILLS_PAYLOAD_DIR: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/skills',
        DEBRUTE_RUNTIME_HOST_MANAGED_BIN_DIR: '/Users/me/.debrute/bin',
        DEBRUTE_RUNTIME_HOST_MANAGED_PRODUCT_ROOT: '/Users/me/.debrute/products',
        DEBRUTE_RUNTIME_HOST_PRODUCT_MANIFEST_PATH: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/product-manifest.json',
        DEBRUTE_RUNTIME_HOST_DESKTOP_INSTALL_PATH: '/Applications/Debrute.app/Contents/MacOS/debrute',
        DEBRUTE_RUNTIME_HOST_REPLACEMENT_HELPER_PATH: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/product-replacement-helper.cjs',
        DEBRUTE_RUNTIME_HOST_DESKTOP_PID: '1234'
      }
    });

    expect(config).toEqual({
      host: '127.0.0.1',
      daemonPort: 17321,
      tokenFile: '/tmp/debrute-token',
      webDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar/dist',
      productVersion: '0.2.0',
      cliPayloadDir: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/cli',
      skillsPayloadDir: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/skills',
      managedBinDir: '/Users/me/.debrute/bin',
      managedProductRoot: '/Users/me/.debrute/products',
      productManifestPath: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/product-manifest.json',
      desktopInstallPath: '/Applications/Debrute.app/Contents/MacOS/debrute',
      replacementHelperPath: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/product-replacement-helper.cjs',
      desktopPid: 1234
    });
  });

  it('passes product replacement config into the default product update service', () => {
    const source = readFileSync(join(process.cwd(), 'apps/runtime-host/src/runtimeHost.ts'), 'utf8');

    expect(source).toContain('desktopInstallPath: config.desktopInstallPath');
    expect(source).toContain('managedProductRoot: config.managedProductRoot');
    expect(source).toContain('const replacementHelperCommand = managedCli.replacementHelperCommand();');
    expect(source).toContain('...(config.desktopPid !== undefined ? { desktopPid: config.desktopPid } : {})');
    expect(source).toContain('spawnReplacementHelper: createRuntimeHostReplacementHelperSpawner(replacementHelperCommand)');
  });

  it('does not print runtime state because it contains the daemon token', () => {
    const source = readFileSync(join(process.cwd(), 'apps/runtime-host/src/runtimeHost.ts'), 'utf8');

    expect(source).not.toContain('JSON.stringify(state)');
    expect(source).not.toContain('process.stdout.write');
  });
});
