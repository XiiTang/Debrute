import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { desktopProductRuntimeConfig } from '../apps/desktop/src/electron/runtime/desktopProductRuntimeConfig';

describe('desktop fresh install product payload', () => {
  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')) as {
    build?: {
      asar?: unknown;
      asarUnpack?: unknown;
    };
  };

  it('keeps runtime product files outside app.asar for process execution and materialization', () => {
    expect(desktopPackage.build?.asar).toBe(true);
    expect(desktopPackage.build?.asarUnpack).toEqual([
      'dist-electron/runtime-host.cjs',
      'dist-electron/canvas-feedback-artifact-worker.cjs',
      'dist-electron/product-replacement-helper.cjs',
      'dist-electron/runtime-product/**'
    ]);
  });

  it('resolves packaged product payload paths from desktop app resources', () => {
    const config = desktopProductRuntimeConfig({
      appVersion: '0.2.0',
      electronDistDir: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron',
      userHome: '/Users/me',
      platform: 'darwin',
      execPath: '/Applications/Debrute.app/Contents/MacOS/debrute',
      appIsPackaged: true,
      desktopPid: 1234
    });

    expect(config).toMatchObject({
      productVersion: '0.2.0',
      cliPayloadDir: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/cli',
      skillsPayloadDir: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/skills',
      managedBinDir: '/Users/me/.debrute/bin',
      managedProductRoot: '/Users/me/.debrute/products',
      productManifestPath: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/runtime-product/product-manifest.json',
      replacementHelperPath: '/Applications/Debrute.app/Contents/Resources/app.asar.unpacked/dist-electron/product-replacement-helper.cjs',
      desktopInstallPath: '/Applications/Debrute.app/Contents/MacOS/debrute',
      desktopPid: 1234
    });
  });

  it('uses the AppImage file as the packaged Linux desktop install path', () => {
    const config = desktopProductRuntimeConfig({
      appVersion: '0.2.0',
      electronDistDir: '/tmp/.mount_Debrute/resources/app.asar.unpacked/dist-electron',
      userHome: '/home/me',
      platform: 'linux',
      execPath: '/tmp/.mount_Debrute/debrute',
      appImagePath: '/home/me/Downloads/debrute-desktop-0.2.0-linux-x64.AppImage',
      appIsPackaged: true,
      desktopPid: 1234
    });

    expect(config.desktopInstallPath).toBe('/home/me/Downloads/debrute-desktop-0.2.0-linux-x64.AppImage');
  });

  it('rejects packaged Linux desktop launch without an AppImage install path', () => {
    expect(() => desktopProductRuntimeConfig({
      appVersion: '0.2.0',
      electronDistDir: '/tmp/.mount_Debrute/resources/app.asar.unpacked/dist-electron',
      userHome: '/home/me',
      platform: 'linux',
      execPath: '/tmp/.mount_Debrute/debrute',
      appIsPackaged: true,
      desktopPid: 1234
    })).toThrow(/APPIMAGE/);
  });

  it('bundle-electron writes the runtime product payload, manifest, and replacement helper', () => {
    const source = readFileSync(join(process.cwd(), 'apps/desktop/scripts/bundle-electron.mjs'), 'utf8');

    expect(source).toContain('runtime-product');
    expect(source).toContain('product-manifest.json');
    expect(source).toContain('product-replacement-helper.cjs');
    expect(source).toContain('packageDebruteCliRuntimePayload');
    expect(source).toContain("join(workspaceRoot, 'skills')");
  });
});
