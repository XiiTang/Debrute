import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveMountedDesktopApp } from '../../scripts/verify-macos-desktop-signing.mjs';

describe('GitHub release workflow contract', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/debrute-release.yml'), 'utf8');
  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));
  const packagedDesktopSmoke = readFileSync(
    join(process.cwd(), 'scripts/smoke-packaged-desktop.mjs'),
    'utf8'
  );

  it('uses a release workflow with preflight, Desktop, and final publish jobs', () => {
    expect(workflow).toContain('preflight:');
    expect(workflow).toContain('node scripts/validate-release-version-contract.mjs');
    expect(workflow).toContain('runs-on: macos-latest');
    expect(workflow).toContain('Prepare pinned native raster payload');
    expect(workflow).toContain('pnpm native:raster:prepare');
    expect(workflow).toContain('build-desktop:');
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
  });

  it('rejects unexpected files from the final release upload set', () => {
    const publishReleaseBlock = workflow.slice(workflow.indexOf('publish-release:'));

    expect(publishReleaseBlock).toContain('Unexpected release assets');
    expect(publishReleaseBlock).toContain('Duplicate release asset');
  });

  it('does not publish directly from matrix build jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    expect(buildDesktopBlock).not.toContain('softprops/action-gh-release');
  });

  it('builds Desktop release assets from the workspace root in fresh matrix jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    expect(buildDesktopBlock).toContain('- run: pnpm build');
    expect(buildDesktopBlock).toContain('electron-builder --mac dmg --${{ matrix.arch }} --publish never');
    expect(buildDesktopBlock).toContain('electron-builder --win nsis --x64 --publish never');
    expect(buildDesktopBlock).toContain('debrute-desktop-${{ matrix.publicPlatform }}-${{ matrix.arch }}');
    expect(workflow).toContain('Generate signed update manifest');
    expect(buildDesktopBlock).toContain('Archive signed Product seed');
    expect(buildDesktopBlock).toContain('node scripts/archive-product-seed.mjs');
    expect(buildDesktopBlock).toContain('debrute-product-*-${{ matrix.publicPlatform }}-${{ matrix.arch }}.zip');
  });

  it('smoke tests signed macOS and Windows packages through the public product surface', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));

    expect(buildDesktopBlock).toContain('Smoke test signed packaged Desktop and Runtime');
    expect(buildDesktopBlock).toContain('scripts/smoke-packaged-desktop.mjs');
    expect(buildDesktopBlock).toContain('win-unpacked/debrute.exe');
    expect(buildDesktopBlock).toContain('Debrute.app/Contents/MacOS/Debrute');
    expect(packagedDesktopSmoke).toContain('runtime_state=ready');
    expect(packagedDesktopSmoke).toContain('native_tray=active');
    expect(packagedDesktopSmoke).toContain('chromium.connectOverCDP');
    expect(packagedDesktopSmoke).toContain('window.debruteShell');
    expect(packagedDesktopSmoke).toContain('workbench-connection-ended');
    expect(packagedDesktopSmoke).toContain("runCli(options.cli, ['runtime', 'stop'], Date.now() + 15_000)");
    expect(packagedDesktopSmoke).toContain("spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F']");
    expect(packagedDesktopSmoke).toContain("process.kill(-pid, 'SIGKILL')");
    expect(packagedDesktopSmoke).toContain('AbortSignal.timeout');
    expect(packagedDesktopSmoke).toContain("child.kill('SIGKILL')");
    expect(packagedDesktopSmoke).not.toMatch(/(?:pkill|killall|Get-Process)/);
  });

  it('signs native Product binaries before assembling each supported Product archive', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    const archiveIndex = buildDesktopBlock.indexOf('Archive signed Product seed');

    expect(buildDesktopBlock).toContain('Sign macOS Product binaries and rebuild the strict seed');
    expect(buildDesktopBlock).toContain('codesign --verify --strict --verbose=2 "$binary"');
    expect(buildDesktopBlock).toContain('Sign Windows Product binaries and rebuild the strict seed');
    expect(buildDesktopBlock).toContain('WINDOWS_CSC_LINK_SECRET: ${{ secrets.WINDOWS_CSC_LINK }}');
    expect(buildDesktopBlock).toContain('& $signTool verify /pa /v $binary');
    expect(buildDesktopBlock.indexOf('Sign macOS Product binaries')).toBeLessThan(archiveIndex);
    expect(buildDesktopBlock.indexOf('Sign Windows Product binaries')).toBeLessThan(archiveIndex);
  });

  it('configures the final signed macOS Desktop identity', () => {
    expect(desktopPackage.build.appId).toBe('io.github.xiitang.debrute');
    expect(desktopPackage.build.mac).toMatchObject({
      category: 'public.app-category.productivity',
      artifactName: 'debrute-desktop-${version}-macos-${arch}.${ext}',
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      notarize: false,
      target: ['dmg']
    });
    expect(desktopPackage.build.afterSign).toBe('scripts/notarize-macos-app.cjs');
    expect(desktopPackage.build.executableName).toBe('debrute');
    expect(desktopPackage.build.dmg).toMatchObject({ sign: true });

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
    expect(script).toContain("join(mountDir, 'Debrute.app')");
    expect(script).toContain('io.github.xiitang.debrute');
    expect(script).toContain('debrute-desktop-${version}-macos-${arch}.dmg');
  });

  it('accepts only the fixed real Debrute.app directory at the DMG root', () => {
    const root = mkdtempSync(join(tmpdir(), 'debrute-dmg-contract-'));
    const dmgPath = join(root, 'Debrute.dmg');
    try {
      const missing = join(root, 'missing');
      mkdirSync(missing);
      expect(() => resolveMountedDesktopApp(missing, dmgPath)).toThrow('Expected Debrute.app');

      const otherOnly = join(root, 'other-only');
      mkdirSync(join(otherOnly, 'Other.app'), { recursive: true });
      expect(() => resolveMountedDesktopApp(otherOnly, dmgPath)).toThrow('Expected Debrute.app');

      const symlinkMount = join(root, 'symlink');
      const symlinkTarget = join(root, 'symlink-target');
      mkdirSync(symlinkMount);
      mkdirSync(symlinkTarget);
      symlinkSync(symlinkTarget, join(symlinkMount, 'Debrute.app'), process.platform === 'win32' ? 'junction' : 'dir');
      expect(() => resolveMountedDesktopApp(symlinkMount, dmgPath)).toThrow('real Debrute.app directory');

      const valid = join(root, 'valid');
      const appPath = join(valid, 'Debrute.app');
      mkdirSync(appPath, { recursive: true });
      expect(resolveMountedDesktopApp(valid, dmgPath)).toBe(appPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires Apple signing, notarization, and verification for macOS Desktop release jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));

    expect(buildDesktopBlock).toContain('Prepare Apple signing and notarization credentials');
    expect(buildDesktopBlock).toContain("if: matrix.platform == 'darwin'");
    expect(buildDesktopBlock).toContain('APPLE_API_KEY_SECRET: ${{ secrets.APPLE_API_KEY }}');
    expect(buildDesktopBlock).toContain('APPLE_API_KEY_ID: ${{ secrets.APPLE_API_KEY_ID }}');
    expect(buildDesktopBlock).toContain('APPLE_API_ISSUER: ${{ secrets.APPLE_API_ISSUER }}');
    expect(buildDesktopBlock).toContain('CSC_LINK_SECRET: ${{ secrets.CSC_LINK }}');
    expect(buildDesktopBlock).toContain('CSC_KEY_PASSWORD_SECRET: ${{ secrets.CSC_KEY_PASSWORD }}');
    expect(buildDesktopBlock).toContain('APPLE_API_KEY_PATH="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"');
    expect(buildDesktopBlock).toContain('P12_PATH="$RUNNER_TEMP/developer-id-application.p12"');
    expect(buildDesktopBlock).toContain('DEVELOPER_ID_G2_PATH="$RUNNER_TEMP/DeveloperIDG2CA.cer"');
    expect(buildDesktopBlock).toContain("printf '%s' \"$CSC_LINK_SECRET\" | base64 --decode > \"$P12_PATH\"");
    expect(buildDesktopBlock).toContain('curl -fsSL https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer');
    expect(buildDesktopBlock).toContain('SIGNING_KEYCHAIN="$RUNNER_TEMP/debrute-signing.keychain-db"');
    expect(buildDesktopBlock).toContain('security import "$DEVELOPER_ID_G2_PATH"');
    expect(buildDesktopBlock).toContain('security import "$P12_PATH"');
    expect(buildDesktopBlock).toContain('security set-key-partition-list');
    expect(buildDesktopBlock).toContain("security find-identity -v -p codesigning \"$SIGNING_KEYCHAIN\" | grep 'Developer ID Application: Hongrui Wu (FR25929R7Z)'");
    expect(buildDesktopBlock).toContain('echo "CSC_NAME=Hongrui Wu (FR25929R7Z)"');
    expect(buildDesktopBlock).toContain('Build signed macOS Desktop assets');
    expect(buildDesktopBlock).toContain('electron-builder --mac dmg --${{ matrix.arch }} --publish never');
    expect(buildDesktopBlock).not.toContain('CSC_LINK: ${{ secrets.CSC_LINK }}');
    expect(buildDesktopBlock).not.toContain('CSC_KEY_PASSWORD: ${{ secrets.CSC_KEY_PASSWORD }}');
    expect(buildDesktopBlock).toContain('Notarize macOS DMG');
    expect(buildDesktopBlock).toContain('node scripts/notarize-macos-artifact.cjs');
    expect(buildDesktopBlock).toContain('--path "$DMG_PATH"');
    expect(buildDesktopBlock).toContain('Verify macOS signing');
    expect(buildDesktopBlock).toContain('node scripts/verify-macos-desktop-signing.mjs');
    expect(buildDesktopBlock).toContain('--bundle-id io.github.xiitang.debrute');
    expect(buildDesktopBlock).toContain("if: matrix.platform == 'win32'");
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
