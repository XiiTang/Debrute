import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMountedProductSetup } from '../../scripts/verify-macos-desktop-signing.mjs';

describe('GitHub release workflow contract', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/debrute-release.yml'), 'utf8');
  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
  const packagedDesktopSmoke = readFileSync(
    join(process.cwd(), 'scripts/smoke-packaged-desktop.mjs'),
    'utf8'
  );
  const productRemovalSmoke = readFileSync(
    join(process.cwd(), 'scripts/smoke-product-removal.mjs'),
    'utf8'
  );
  const managedCliProcess = readFileSync(
    join(process.cwd(), 'scripts/run-managed-cli.mjs'),
    'utf8'
  );

  it('uses a release workflow with preflight, Product, and final publish jobs', () => {
    expect(workflow).toContain('preflight:');
    expect(workflow).toContain('node scripts/validate-release-version-contract.mjs');
    expect(workflow).toContain('runs-on: macos-15-intel');
    expect(workflow).toContain('run: brew install ripgrep');
    expect(workflow).toContain('Prepare pinned native raster payload');
    expect(workflow).toContain('pnpm native:raster:prepare');
    expect(workflow).toContain('build-product:');
    expect(workflow).toContain('publish-release:');
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: false');
    expect(workflow).toContain('debrute-update-manifest.json');
    expect(workflow).toContain('debrute-update-manifest.json.sig');
    expect(workflow).toContain('DEBRUTE_UPDATE_SIGNING_PRIVATE_KEY_PEM: ${{ secrets.DEBRUTE_UPDATE_SIGNING_PRIVATE_KEY_PEM }}');
    expect(workflow).toContain('node scripts/generate-update-manifest.mjs --release-dir release-upload --version "$VERSION"');
    expect(workflow).toContain('release-notes.md');
    expect(workflow).toContain('body_path: release-notes.md');
    expect(workflow).toContain('softprops/action-gh-release@v2');
  });

  it('documents the signed manifest public release contract', () => {
    const releaseDocs = readFileSync(join(process.cwd(), 'docs/releases.md'), 'utf8');

    expect(releaseDocs).toContain('debrute-update-manifest.json');
    expect(releaseDocs).toContain('debrute-update-manifest.json.sig');
    expect(releaseDocs).toContain('Signed Manifest Verification');
    expect(releaseDocs).toContain('debrute-product-X.Y.Z-macos-arm64.zip');
    expect(releaseDocs).toContain('debrute-product-X.Y.Z-windows-x64.zip');
    expect(releaseDocs).toContain('required eight-file');
    expect(releaseDocs).toMatch(/not\s+Authenticode-signed/);
    expect(releaseDocs).toContain('Unknown Publisher');
  });

  it('preserves byte-hashed Canvas font subset inputs across Windows checkout', () => {
    const gitAttributes = readFileSync(join(process.cwd(), '.gitattributes'), 'utf8');

    expect(gitAttributes).toContain('scripts/canvas-text-font-subset/*.cc text eol=lf');
    expect(gitAttributes).toContain('scripts/canvas-text-font-subset/*.h text eol=lf');
    expect(gitAttributes).toContain('assets/wasm/LICENSES/*.txt text eol=lf');
    expect(gitAttributes).toContain('assets/wasm/*.wasm binary');
  });

  it('rejects unexpected files from the final release upload set', () => {
    const publishReleaseBlock = workflow.slice(workflow.indexOf('publish-release:'));

    expect(publishReleaseBlock).toContain('Unexpected release assets');
    expect(publishReleaseBlock).toContain('Duplicate release asset');
  });

  it('does not publish directly from matrix build jobs', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));
    expect(buildProductBlock).not.toContain('softprops/action-gh-release');
  });

  it('builds Product Installer assets from the workspace root in fresh matrix jobs', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));
    expect(buildProductBlock).toContain('- run: pnpm build');
    expect(buildProductBlock).toContain('electron-builder --mac dir --${{ matrix.arch }} --publish never');
    expect(buildProductBlock).toContain('build-macos-product-installer.mjs');
    expect(buildProductBlock).toContain('electron-builder --win nsis --x64 --publish never');
    expect(buildProductBlock).toContain('debrute-installer-${{ matrix.publicPlatform }}-${{ matrix.arch }}');
    expect(workflow).toContain('Generate signed update manifest');
    expect(buildProductBlock).toContain('Archive Product seed');
    expect(buildProductBlock).toContain('node scripts/archive-product-seed.mjs');
    expect(buildProductBlock).toContain('debrute-product-*-${{ matrix.publicPlatform }}-${{ matrix.arch }}.zip');
  });

  it('blocks every Product release build on the supervised native Project watcher probe', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));
    const watcherProbeIndex = buildProductBlock.indexOf('- name: Verify native Project watcher');
    const watcherProbeStep = buildProductBlock.slice(
      watcherProbeIndex,
      buildProductBlock.indexOf('- name: Test Windows Rust product commit primitives')
    );

    expect(watcherProbeIndex).toBeGreaterThan(-1);
    expect(watcherProbeStep).not.toContain('if:');
    expect(watcherProbeStep).toContain('run: pnpm test:rust:native-watcher');
    expect(watcherProbeIndex).toBeLessThan(buildProductBlock.indexOf('- run: pnpm build'));
  });

  it('blocks the Windows package on exhaustive Rust and real-browser verification', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));
    const rustGateIndex = buildProductBlock.indexOf('Check exhaustive Windows Rust targets');
    const browserGateIndex = buildProductBlock.indexOf('Verify Windows Workbench in a real browser');
    const buildIndex = buildProductBlock.indexOf('- run: pnpm build');

    expect(rustGateIndex).toBeGreaterThan(-1);
    expect(browserGateIndex).toBeGreaterThan(-1);
    expect(buildProductBlock.slice(rustGateIndex, browserGateIndex)).toContain("if: matrix.platform == 'win32'");
    expect(buildProductBlock.slice(browserGateIndex, buildIndex)).toContain("if: matrix.platform == 'win32'");
    expect(buildProductBlock).toContain('run: pnpm check:rust:all');
    expect(buildProductBlock).toContain('run: pnpm verify:browser');
    expect(rustGateIndex).toBeLessThan(buildIndex);
    expect(browserGateIndex).toBeLessThan(buildIndex);
  });

  it('smoke tests macOS and Windows packages through the public product surface', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));

    expect(buildProductBlock).toContain('Smoke test packaged Desktop and Runtime');
    expect(buildProductBlock).toContain('scripts/install-product-smoke.mjs');
    expect(packagedDesktopSmoke).toContain('verifyInstalledRuntimeSubsystem');
    expect(packagedDesktopSmoke).toContain(
      "join(dirname(cli), '..', 'products', 'current', 'runtime', 'debrute-runtime.exe')"
    );
    expect(packagedDesktopSmoke).not.toContain("join(dirname(cli), 'debrute-runtime.exe')");
    expect(packagedDesktopSmoke).not.toContain('Bundled CLI');
    expect(packagedDesktopSmoke).not.toContain('Bundled Runtime');
    expect(buildProductBlock).toContain('--platform darwin --installer "$INSTALLER"');
    expect(buildProductBlock).toContain('scripts/smoke-packaged-desktop.mjs');
    expect(buildProductBlock).toContain('scripts/smoke-product-removal.mjs');
    expect(buildProductBlock).toContain('--desktop-root "$DESKTOP_ROOT"');
    expect(buildProductBlock).toContain('$LOCALAPPDATA\\Programs\\Debrute\\Debrute.exe');
    expect(buildProductBlock).toContain('$USERPROFILE\\.debrute\\bin\\debrute.cmd');
    expect(buildProductBlock).toContain('Debrute.app/Contents/MacOS/Debrute');
    expect(packagedDesktopSmoke).toContain('runtime_state=ready');
    expect(packagedDesktopSmoke).toContain('chromium.connectOverCDP');
    expect(packagedDesktopSmoke).toContain("page.locator('#root > *').waitFor");
    expect(packagedDesktopSmoke).toContain("page.locator('[data-testid=\"workbench-titlebar\"]').waitFor");
    expect(packagedDesktopSmoke).toContain('window.debruteShell');
    expect(packagedDesktopSmoke).toContain('workbench-connection-ended');
    expect(packagedDesktopSmoke).toContain("runCli(options.cli, ['runtime', 'stop'], Date.now() + 15_000)");
    expect(packagedDesktopSmoke).toContain("import { terminateWindowsProcessTree } from './terminate-windows-process-tree.mjs'");
    expect(packagedDesktopSmoke).toContain('await terminateWindowsProcessTree(child');
    expect(packagedDesktopSmoke).not.toContain("spawnSync('taskkill.exe'");
    expect(packagedDesktopSmoke).toContain("process.kill(-child.pid, 'SIGKILL')");
    expect(packagedDesktopSmoke).toContain('AbortSignal.timeout');
    expect(packagedDesktopSmoke).toContain("import { runManagedCli } from './run-managed-cli.mjs'");
    expect(managedCliProcess).toContain("process.env.ComSpec ?? 'cmd.exe'");
    expect(managedCliProcess).toContain('terminateWindowsProcessTree(child');
    expect(managedCliProcess).toContain("child.kill('SIGKILL')");
    expect(packagedDesktopSmoke).toContain('function delay(milliseconds)');
    expect(packagedDesktopSmoke).not.toContain('const delay =');
    expect(packagedDesktopSmoke).not.toMatch(/(?:pkill|killall|Get-Process)/);
    expect(packagedDesktopSmoke).toContain('verifyMacosDesktopSignature(options)');
    expect(packagedDesktopSmoke).not.toContain('Get-AuthenticodeSignature');
    expect(productRemovalSmoke).toContain("'product', 'uninstall', '--yes'");
    expect(productRemovalSmoke).toContain('configPreserved=false');
    expect(productRemovalSmoke).toContain(
      "const unrelatedSkill = await mkdtemp(join(skills, 'unrelated-product-removal-smoke-'))"
    );
    expect(productRemovalSmoke).not.toContain('const unrelatedSkill = join(skills');
    expect(productRemovalSmoke).toContain('Debrute Runtime');
    expect(productRemovalSmoke).toContain('@debrutedesktop-updater');
    expect(productRemovalSmoke).toContain('com.debrute.runtime.plist');
    expect(productRemovalSmoke).toContain('.debrute-shell-');
    expect(productRemovalSmoke).toContain('.debrute-projection-');
  });

  it('signs macOS Product binaries and publishes Windows without Authenticode', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));
    const archiveIndex = buildProductBlock.indexOf('Archive Product seed');

    expect(buildProductBlock).toContain('Sign macOS Product binaries and rebuild the strict seed');
    expect(buildProductBlock).toContain('codesign --verify --strict --verbose=2 "$binary"');
    expect(buildProductBlock.indexOf('Sign macOS Product binaries')).toBeLessThan(archiveIndex);
    expect(buildProductBlock).toContain('Build unsigned Windows Product Installer');
    expect(buildProductBlock).not.toContain('Sign Windows Product binaries');
    expect(buildProductBlock).not.toContain('WINDOWS_CSC_LINK');
    expect(buildProductBlock).not.toContain('WINDOWS_CSC_KEY_PASSWORD');
    expect(buildProductBlock).not.toContain('signtool.exe');
    expect(buildProductBlock).toContain('Verify Windows Product binaries are Authenticode-unsigned');
    expect(buildProductBlock).toContain('Get-AuthenticodeSignature -LiteralPath $path');
    expect(buildProductBlock).toContain('[System.Management.Automation.SignatureStatus]::NotSigned');
    expect(buildProductBlock).toContain('target/release/debrute-runtime.exe');
    expect(buildProductBlock).toContain('target/release/debrute.exe');
    expect(buildProductBlock).toContain('debrute-installer-$version-windows-x64.exe');
    expect(desktopPackage.build.win).toMatchObject({
      signExecutable: false
    });
  });

  it('configures the final signed macOS Desktop identity', () => {
    expect(desktopPackage.build.appId).toBe('io.github.xiitang.debrute');
    expect(desktopPackage.build.mac).toMatchObject({
      category: 'public.app-category.productivity',
      executableName: 'Debrute',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      notarize: false,
      target: ['dir']
    });
    expect(desktopPackage.build.afterSign).toBe('scripts/notarize-macos-app.cjs');
    expect(desktopPackage.build.executableName).toBe('debrute');
    expect(desktopPackage.build.win.executableName).toBe('Debrute');
    expect(desktopPackage.build.dmg).toBeUndefined();

    const entitlements = readFileSync(
      join(process.cwd(), 'apps/desktop/build/entitlements.mac.plist'),
      'utf8'
    );
    const inheritedEntitlements = readFileSync(
      join(process.cwd(), 'apps/desktop/build/entitlements.mac.inherit.plist'),
      'utf8'
    );
    for (const plist of [entitlements, inheritedEntitlements]) {
      expect(plist).toContain('com.apple.security.cs.allow-jit');
      expect(plist).toContain('com.apple.security.cs.allow-unsigned-executable-memory');
      expect(plist).toContain('com.apple.security.cs.disable-library-validation');
      expect(plist).not.toContain('com.apple.security.cs.allow-dyld-environment-variables');
    }
  });

  it('defines a macOS signing verification script for final artifacts', () => {
    const script = readFileSync(join(process.cwd(), 'scripts/verify-macos-desktop-signing.mjs'), 'utf8');

    expect(script).toContain('codesign');
    expect(script).toContain('spctl');
    expect(script).toContain('xcrun');
    expect(script).toContain('stapler');
    expect(script).toContain('hdiutil');
    expect(script).toContain('plutil');
    expect(script).toContain('CFBundleIdentifier');
    expect(script).toContain('lstatSync');
    expect(script).toContain('isSymbolicLink');
    expect(script).toContain("join(mountDir, 'Install Debrute.app')");
    expect(script).toContain('io.github.xiitang.debrute');
    expect(script).toContain('debrute-installer-${version}-macos-${arch}.dmg');
  });

  it('accepts only the fixed real Product Setup application at the DMG root', () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-dmg-contract-'));
    const dmgPath = join(root, 'Debrute.dmg');
    try {
      const missing = join(root, 'missing');
      mkdirSync(missing);
      expect(() => resolveMountedProductSetup(missing, dmgPath)).toThrow('Expected Install Debrute.app');

      const otherOnly = join(root, 'other-only');
      mkdirSync(join(otherOnly, 'Other.app'), { recursive: true });
      expect(() => resolveMountedProductSetup(otherOnly, dmgPath)).toThrow('Expected Install Debrute.app');

      const symlinkMount = join(root, 'symlink');
      const symlinkTarget = join(root, 'symlink-target');
      mkdirSync(symlinkMount);
      mkdirSync(symlinkTarget);
      symlinkSync(symlinkTarget, join(symlinkMount, 'Install Debrute.app'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveMountedProductSetup(symlinkMount, dmgPath)).toThrow('real Install Debrute.app directory');

      const valid = join(root, 'valid');
      const appPath = join(valid, 'Install Debrute.app');
      mkdirSync(appPath, { recursive: true });
      expect(resolveMountedProductSetup(valid, dmgPath)).toBe(appPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires Apple signing, notarization, and verification for macOS Desktop release jobs', () => {
    const buildProductBlock = workflow.slice(workflow.indexOf('build-product:'), workflow.indexOf('publish-release:'));

    expect(buildProductBlock).toContain('Prepare Apple signing and notarization credentials');
    expect(buildProductBlock).toContain("if: matrix.platform == 'darwin'");
    expect(buildProductBlock).toContain('APPLE_API_KEY_SECRET: ${{ secrets.APPLE_API_KEY }}');
    expect(buildProductBlock).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}');
    expect(buildProductBlock).toContain('APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}');
    expect(buildProductBlock).toContain('CSC_LINK_SECRET: ${{ secrets.CSC_LINK }}');
    expect(buildProductBlock).toContain('CSC_KEY_PASSWORD_SECRET: ${{ secrets.CSC_KEY_PASSWORD }}');
    expect(buildProductBlock).toContain('APPLE_API_KEY_PATH="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"');
    expect(buildProductBlock).toContain('P12_PATH="$RUNNER_TEMP/developer-id-application.p12"');
    expect(buildProductBlock).toContain('DEVELOPER_ID_G2_PATH="$RUNNER_TEMP/DeveloperIDG2CA.cer"');
    expect(buildProductBlock).toContain("printf '%s' \"$CSC_LINK_SECRET\" | base64 --decode > \"$P12_PATH\"");
    expect(buildProductBlock).toContain('curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer');
    expect(buildProductBlock).toContain('SIGNING_KEYCHAIN="$RUNNER_TEMP/debrute-signing.keychain-db"');
    expect(buildProductBlock).toContain('security import "$DEVELOPER_ID_G2_PATH"');
    expect(buildProductBlock).toContain('security import "$P12_PATH"');
    expect(buildProductBlock).toContain('security set-key-partition-list');
    expect(buildProductBlock).toContain("security find-identity -v -p codesigning \"$SIGNING_KEYCHAIN\" | grep 'Developer ID Application: Hongrui Wu (FR25929R7Z)'");
    expect(buildProductBlock).toContain('echo "CSC_NAME=Hongrui Wu (FR25929R7Z)"');
    expect(buildProductBlock).toContain('Build signed macOS Product Installer');
    expect(buildProductBlock).toContain('electron-builder --mac dir --${{ matrix.arch }} --publish never');
    expect(buildProductBlock).toContain('build-macos-product-installer.mjs');
    expect(buildProductBlock).not.toContain('CSC_LINK: ${{ secrets.CSC_LINK }}');
    expect(buildProductBlock).not.toContain('CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}');
    expect(buildProductBlock).toContain('Notarize macOS DMG');
    expect(buildProductBlock).toContain('node scripts/notarize-macos-artifact.cjs');
    expect(buildProductBlock).toContain('--path "$DMG_PATH"');
    expect(buildProductBlock).toContain('Verify macOS signing');
    expect(buildProductBlock).toContain('node scripts/verify-macos-desktop-signing.mjs');
    expect(buildProductBlock).toContain('--bundle-id io.github.xiitang.debrute');
    expect(buildProductBlock).toContain("if: matrix.platform == 'win32'");
  });

  it('routes application notarization through the shared artifact helper', () => {
    const notarizeAppScript = readFileSync(
      join(process.cwd(), 'apps/desktop/scripts/notarize-macos-app.cjs'),
      'utf8'
    );

    expect(notarizeAppScript).toContain('ditto');
    expect(notarizeAppScript).toContain('notarizeAndStaple');
  });

  it('runs every Node-backed release job under Node.js 24', () => {
    const configuredNodeVersions = [...workflow.matchAll(/node-version:\s*(\d+)/g)].map((match) => match[1]);

    expect(configuredNodeVersions).toEqual(['24', '24', '24']);
  });
});
