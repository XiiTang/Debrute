import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub release workflow contract', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/debrute-release.yml'), 'utf8');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
  const desktopPackage = JSON.parse(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8'));

  it('uses a release workflow with preflight, CLI, Desktop, and final publish jobs', () => {
    expect(workflow).toContain('preflight:');
    expect(workflow).toContain('node scripts/validate-release-version-contract.mjs');
    expect(workflow).toContain('Install ripgrep');
    expect(workflow).toContain('sudo apt-get update && sudo apt-get install -y ripgrep');
    expect(workflow).toContain('build-cli:');
    expect(workflow).toContain('build-desktop:');
    expect(workflow).not.toContain('build-photoshop-plugins:');
    expect(workflow).not.toContain('pnpm package:photoshop-plugin');
    expect(workflow).not.toContain('release/photoshop-uxp/debrute-photoshop-uxp-*.ccx');
    expect(workflow).not.toContain('release/photoshop-cep/debrute-photoshop-cep-*.zip');
    expect(workflow).not.toContain('name: photoshop-plugins');
    expect(workflow).toContain('publish-release:');
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: false');
    expect(workflow).toContain('debrute_SHA256SUMS');
    expect(workflow).toContain('release-notes.md');
    expect(workflow).toContain('body_path: release-notes.md');
    expect(workflow).toContain('softprops/action-gh-release@v2');
  });

  it('does not publish directly from matrix build jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    expect(buildDesktopBlock).not.toContain('softprops/action-gh-release');
  });

  it('builds Desktop release assets from the workspace root in fresh matrix jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    expect(buildDesktopBlock).toContain('- run: pnpm build');
    expect(buildDesktopBlock).not.toContain('- run: pnpm --filter @debrute/desktop build');
    expect(buildDesktopBlock).toContain('electron-builder --mac dmg --${{ matrix.arch }} --publish never');
    expect(buildDesktopBlock).not.toContain('electron-builder --mac zip --universal --publish never');
    expect(buildDesktopBlock).toContain('electron-builder --win nsis --x64 --publish never');
    expect(buildDesktopBlock).toContain('electron-builder --linux AppImage --x64 --publish never');
    expect(buildDesktopBlock).not.toContain('latest-mac.yml');
    expect(buildDesktopBlock).toContain('latest.yml');
    expect(buildDesktopBlock).toContain('debrute-desktop-${{ matrix.publicPlatform }}-${{ matrix.arch }}');
    expect(buildDesktopBlock).not.toContain('arch: universal');
    expect(buildDesktopBlock).not.toContain('Rename Desktop assets');
    expect(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')).toContain('"electron-updater"');
    expect(workflow).not.toContain('sha256sum debrute-*');
    expect(workflow).toContain('find . -maxdepth 1 -type f ! -name debrute_SHA256SUMS');
  });

  it('configures the final signed macOS Desktop identity', () => {
    expect(desktopPackage.build.appId).toBe('io.github.xiitang.debrute');
    expect(desktopPackage.build.appId).not.toBe('dev.debrute.desktop');
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
    expect(desktopPackage.build.linux).toMatchObject({
      artifactName: 'debrute-desktop-${version}-linux-x64.${ext}',
      category: 'Utility',
      syncDesktopName: true
    });
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
    expect(script).toContain('io.github.xiitang.debrute');
    expect(script).toContain('debrute-desktop-${version}-macos-${arch}.dmg');
    expect(script).not.toContain('debrute-desktop-${version}-macos-universal.zip');
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
    expect(buildDesktopBlock).toContain("if: matrix.platform != 'darwin'");
  });

  it('uses explicit macOS notarization polling instead of electron-builder internal waiting', () => {
    const notarizeAppScript = readFileSync(
      join(process.cwd(), 'apps/desktop/scripts/notarize-macos-app.cjs'),
      'utf8'
    );
    const notarizeArtifactScript = readFileSync(
      join(process.cwd(), 'scripts/notarize-macos-artifact.cjs'),
      'utf8'
    );

    expect(notarizeAppScript).toContain('ditto');
    expect(notarizeAppScript).toContain('notarizeAndStaple');
    expect(notarizeArtifactScript).toContain('notarytool');
    expect(notarizeArtifactScript).toContain('submit');
    expect(notarizeArtifactScript).toContain('info');
    expect(notarizeArtifactScript).toContain('stapler');
    expect(notarizeArtifactScript).toContain('retrying');
    expect(notarizeArtifactScript).not.toContain('timeoutMinutes');
    expect(notarizeArtifactScript).not.toContain('Timed out waiting');
  });

  it('runs every Node-backed release job under Node.js 24', () => {
    const configuredNodeVersions = [...workflow.matchAll(/node-version:\s*(\d+)/g)].map((match) => match[1]);

    expect(configuredNodeVersions).toEqual(['24', '24', '24', '24']);
    expect(workflow).not.toContain('node-version: 22');
  });

  it('documents signed macOS Desktop releases, Debrute CLI install, and Skills sync', () => {
    expect(readme).toContain('GitHub Releases');
    expect(readme).toContain('macOS Desktop builds are signed and notarized');
    expect(readme).toContain('APPLE_API_KEY');
    expect(readme).toContain('APPLE_API_KEY_ID');
    expect(readme).toContain('APPLE_API_ISSUER');
    expect(readme).toContain('CSC_LINK');
    expect(readme).toContain('CSC_KEY_PASSWORD');
    expect(readme).not.toContain('Current Desktop builds are unsigned');
    expect(readme).not.toContain('right-click Open');
    expect(readme).toContain('Windows may show SmartScreen');
    expect(readme).toContain('Linux AppImage builds may require `chmod +x`');
    expect(readme).toContain('Debrute CLI');
    expect(readme).toContain('debrute skills status');
    expect(readme).toContain('debrute skills sync');
    expect(readme).toContain('debrute skills sync --force');
    expect(readme).toContain('debrute-desktop-X.Y.Z-macos-arm64.dmg');
    expect(readme).not.toContain('debrute-desktop-X.Y.Z-macos-universal.zip');
    expect(readme).not.toContain('latest-mac.yml');
    expect(readme).toContain('latest.yml');
    expect(readme).toContain('packaged Windows builds');
    expect(readme).toContain('macOS and Linux Desktop updates are manual downloads');
    expect(readme).toContain('debrute-cli-X.Y.Z-macos-arm64.tar.gz');
    expect(readme).not.toContain('debrute-photoshop-uxp-X.Y.Z.ccx');
    expect(readme).not.toContain('debrute-photoshop-cep-X.Y.Z.zip');
    expect(readme).not.toContain('Photoshop bridge panel packages');
    expect(readme).not.toContain('copy its `com.debrute.photoshop.bridge.cep` directory');
    expect(readme).toContain('debrute_SHA256SUMS');
    expect(readme).toContain('grep "  debrute-cli-X.Y.Z-macos-arm64.tar.gz$" debrute_SHA256SUMS | shasum -a 256 -c -');
    expect(readme).toContain('sha256sum -c --ignore-missing debrute_SHA256SUMS');
  });
});
