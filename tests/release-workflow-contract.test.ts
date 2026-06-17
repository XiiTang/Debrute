import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub release workflow contract', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/debrute-release.yml'), 'utf8');
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

  it('uses a full release workflow with preflight, CLI, Desktop, and final publish jobs', () => {
    expect(workflow).toContain('preflight:');
    expect(workflow).toContain('node scripts/validate-release-version-contract.mjs');
    expect(workflow).toContain('Install ripgrep');
    expect(workflow).toContain('sudo apt-get update && sudo apt-get install -y ripgrep');
    expect(workflow).toContain('build-cli:');
    expect(workflow).toContain('build-desktop:');
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
    expect(buildDesktopBlock).toContain('electron-builder --mac zip --universal --publish never');
    expect(buildDesktopBlock).toContain('electron-builder --win nsis --x64 --publish never');
    expect(buildDesktopBlock).toContain('electron-builder --linux AppImage --x64 --publish never');
    expect(buildDesktopBlock).toContain('latest-mac.yml');
    expect(buildDesktopBlock).toContain('latest.yml');
    expect(buildDesktopBlock).toContain('debrute-desktop-${{ matrix.publicPlatform }}-${{ matrix.arch }}');
    expect(buildDesktopBlock).not.toContain('Rename Desktop assets');
    expect(readFileSync(join(process.cwd(), 'apps/desktop/package.json'), 'utf8')).toContain('"electron-updater"');
    expect(workflow).not.toContain('sha256sum debrute-*');
    expect(workflow).toContain('find . -maxdepth 1 -type f ! -name debrute_SHA256SUMS');
  });

  it('runs every Node-backed release job under Node.js 24', () => {
    const configuredNodeVersions = [...workflow.matchAll(/node-version:\s*(\d+)/g)].map((match) => match[1]);

    expect(configuredNodeVersions).toEqual(['24', '24', '24', '24']);
    expect(workflow).not.toContain('node-version: 22');
  });

  it('documents unsigned Desktop releases, Debrute CLI install, and Skills sync', () => {
    expect(readme).toContain('GitHub Releases');
    expect(readme).toContain('unsigned');
    expect(readme).toContain('Debrute CLI');
    expect(readme).toContain('debrute skills status');
    expect(readme).toContain('debrute skills sync');
    expect(readme).toContain('debrute skills sync --force');
    expect(readme).toContain('debrute-desktop-X.Y.Z-macos-arm64.dmg');
    expect(readme).toContain('debrute-desktop-X.Y.Z-macos-universal.zip');
    expect(readme).toContain('latest-mac.yml');
    expect(readme).toContain('latest.yml');
    expect(readme).toContain('Desktop app checks for application updates');
    expect(readme).toContain('Linux Desktop updates are manual downloads');
    expect(readme).toContain('debrute-cli-X.Y.Z-macos-arm64.tar.gz');
    expect(readme).toContain('debrute_SHA256SUMS');
    expect(readme).toContain('grep "  debrute-cli-X.Y.Z-macos-arm64.tar.gz$" debrute_SHA256SUMS | shasum -a 256 -c -');
    expect(readme).toContain('sha256sum -c --ignore-missing debrute_SHA256SUMS');
  });
});
