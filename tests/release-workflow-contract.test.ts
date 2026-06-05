import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub release workflow contract', () => {
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/axis-cli-release.yml'), 'utf8');
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
    expect(workflow).toContain('axis_SHA256SUMS');
    expect(workflow).toContain('release-notes.md');
    expect(workflow).toContain('body_path: release-notes.md');
    expect(workflow).toContain('softprops/action-gh-release@v2');
  });

  it('does not publish directly from matrix build jobs', () => {
    const buildDesktopBlock = workflow.slice(workflow.indexOf('build-desktop:'), workflow.indexOf('publish-release:'));
    expect(buildDesktopBlock).not.toContain('softprops/action-gh-release');
  });

  it('documents unsigned Desktop releases, Axis CLI install, and Skills sync', () => {
    expect(readme).toContain('GitHub Releases');
    expect(readme).toContain('unsigned');
    expect(readme).toContain('Axis CLI');
    expect(readme).toContain('axis skills status');
    expect(readme).toContain('axis skills sync');
    expect(readme).toContain('axis skills sync --force');
    expect(readme).toContain('axis-desktop-X.Y.Z-macos-arm64.dmg');
    expect(readme).toContain('axis-cli-X.Y.Z-macos-arm64.tar.gz');
    expect(readme).toContain('axis_SHA256SUMS');
    expect(readme).toContain('grep "  axis-cli-X.Y.Z-macos-arm64.tar.gz$" axis_SHA256SUMS | shasum -a 256 -c -');
    expect(readme).toContain('sha256sum -c --ignore-missing axis_SHA256SUMS');
  });
});
