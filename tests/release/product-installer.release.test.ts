import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('whole-Product installers', () => {
  const root = process.cwd();
  const agentRestartNotice = 'If an Agent was already open before installation, restart it to load Debrute Skills and the debrute command.';
  const desktopPackage = JSON.parse(
    readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
  ) as { build?: { nsis?: Record<string, unknown> } };
  const nsis = readFileSync(join(root, 'apps/desktop/build/product-installer.nsh'), 'utf8');

  it('forces the Windows installer to current-user scope and completes Product installation', () => {
    expect(desktopPackage.build?.nsis).toMatchObject({
      guid: '708c37b7-2547-5a47-9bfa-42bb13156a66',
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: false,
      shortcutName: 'Debrute',
      createDesktopShortcut: false,
      createStartMenuShortcut: true,
      include: 'build/product-installer.nsh'
    });
    expect(nsis).toContain('StrCpy $isForceCurrentInstall "1"');
    expect(nsis).toContain('install-product --seed');
    expect(nsis).toContain('--desktop-entrypoint "$INSTDIR\\Debrute.exe"');
    expect(nsis).toContain('!macro customInit');
    expect(nsis).toContain('preflight-product-version --product-version "${VERSION}"');
    expect(nsis).toContain('stop-product-for-installation');
    expect(nsis).toContain('/DEBRUTE_PRODUCT_UPDATE=');
    expect(nsis).toContain('preflight-product-update-installer --transaction-id');
    expect(nsis).toContain('Desktop payload installed for Product update transaction');
    expect(nsis).toContain('Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"');
    expect(nsis).toContain('RMDir "$LOCALAPPDATA\\@debrutedesktop-updater"');
    expect(nsis).toContain(`!define MUI_FINISHPAGE_TEXT "${agentRestartNotice}"`);
  });

  it('uses one native Windows removal decision and the shared Runtime transaction', () => {
    expect(nsis).toMatch(/!macro customCheckAppRunning\s*!macroend/);
    expect(nsis).toContain('Keep settings and saved API keys for reinstall');
    expect(nsis).toContain('Project contents are not removed');
    expect(nsis).toContain('product uninstall --yes');
    expect(nsis).toContain('--keep-config');
    expect(nsis).toContain('${If} ${isUpdated}');
    expect(nsis).toContain('Removing only the previous Desktop payload');
    expect(nsis).not.toContain('!macro customRemoveFiles');
  });

  it('builds a macOS Setup container instead of publishing a drag-only Desktop DMG', () => {
    const setup = readFileSync(join(root, 'apps/desktop/product-setup/main.swift'), 'utf8');
    const builder = readFileSync(join(root, 'apps/desktop/scripts/build-macos-product-installer.mjs'), 'utf8');
    const distributor = readFileSync(join(root, 'apps/desktop/scripts/build-product-installer.mjs'), 'utf8');
    const smoke = readFileSync(join(root, 'scripts/install-product-smoke.mjs'), 'utf8');

    expect(setup).toContain('preflight-desktop-seed');
    expect(setup).toContain('stop-product-for-installation');
    expect(setup).toContain('install-product');
    expect(setup).toContain('replaceItemAt');
    expect(setup).toContain('appendingPathComponent("Applications"');
    expect(setup).toContain('appendingPathComponent("Debrute.app"');
    expect(setup).toContain('Installation Complete');
    expect(setup).toContain(agentRestartNotice);
    expect(setup).toContain('["--install-noninteractive"]');
    expect(setup).toContain('runNoninteractiveInstall()');
    expect(setup).toContain('let application = try installProduct()');
    expect(setup).toContain('exit(EXIT_SUCCESS)');
    expect(setup).toContain('exit(EXIT_FAILURE)');
    expect(builder).toContain('Install Debrute.app');
    expect(builder).toContain('hdiutil');
    expect(builder).toContain('codesign');
    expect(distributor).toContain('requires a Developer ID CSC_NAME');
    expect(distributor).not.toContain("process.env.CSC_NAME ?? '-'");
    expect(smoke).toContain("join(setup, 'Contents', 'MacOS', 'Install Debrute')");
    expect(smoke).toContain("'--install-noninteractive'");
    expect(smoke).not.toContain("'/usr/bin/ditto'");
    expect(smoke).not.toContain("'install-product'");
  });
});
