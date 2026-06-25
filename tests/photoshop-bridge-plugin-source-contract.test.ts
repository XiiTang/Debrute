import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const uxpSharedModulePaths = [
  'apps/photoshop-uxp-plugin/src/bridgeClient.ts',
  'apps/photoshop-uxp-plugin/src/discoveryClient.ts',
  'apps/photoshop-uxp-plugin/src/projectTreeModel.ts',
  'apps/photoshop-uxp-plugin/src/selectionModel.ts',
  'apps/photoshop-uxp-plugin/src/transferPayloads.ts'
];

describe('Photoshop bridge plugin source contract', () => {
  it('keeps UXP host code on the shared Photoshop bridge core', () => {
    const root = process.cwd();
    const main = readFileSync(join(root, 'apps/photoshop-uxp-plugin/src/main.ts'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-uxp-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(main).toContain("from '@debrute/photoshop-bridge-plugin-core'");
    expect(main).not.toContain("from '@debrute/app-protocol'");
    expect(main).toContain("clientRuntime: 'uxp'");
    for (const path of uxpSharedModulePaths) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  it('keeps CEP host code on the shared Photoshop bridge core', () => {
    const root = process.cwd();
    const main = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/main.ts'), 'utf8');
    const manifest = readFileSync(join(root, 'apps/photoshop-cep-plugin/public/CSXS/manifest.xml'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'apps/photoshop-cep-plugin/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      '@debrute/photoshop-bridge-plugin-core': 'workspace:*'
    });
    expect(main).toContain("from '@debrute/photoshop-bridge-plugin-core'");
    expect(main).not.toContain("from '@debrute/app-protocol'");
    expect(main).toContain("clientRuntime: 'cep'");
    expect(manifest).toContain('ExtensionBundleId="com.debrute.photoshop.bridge.cep"');
  });

  it('keeps UXP bridge panel styling on named host-aware roles', () => {
    const root = process.cwd();
    const styles = readFileSync(join(root, 'apps/photoshop-uxp-plugin/src/styles.css'), 'utf8');
    const main = readFileSync(join(root, 'apps/photoshop-uxp-plugin/src/main.ts'), 'utf8');

    for (const token of [
      '--bridge-bg: var(--uxp-host-background-color)',
      '--bridge-text: var(--uxp-host-text-color)',
      '--bridge-border: var(--uxp-host-border-color)',
      '--bridge-error: var(--uxp-host-error-color)',
      '--bridge-focus: var(--uxp-host-link-color)',
      '--bridge-control-height: 28px',
      '--bridge-font-size: 12px'
    ]) {
      expect(styles).toContain(token);
    }

    for (const className of [
      'bridge-section',
      'bridge-section--status',
      'bridge-section__title',
      'bridge-status-line',
      'bridge-selection-card',
      'bridge-project-card',
      'bridge-action-button',
      'bridge-drop-target',
      'bridge-status-error'
    ]) {
      expect(styles).toContain(`.${className}`);
      expect(main).toContain(className);
    }

    expect(styles).not.toContain('#b42318');
    expect(styles).not.toMatch(/\nbutton\s*\{/);
    expect(styles).not.toMatch(/\nsection\s*\{/);
  });

  it('keeps CEP bridge panel styling on Debrute-compatible semantic roles', () => {
    const root = process.cwd();
    const styles = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/styles.css'), 'utf8');
    const main = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/main.ts'), 'utf8');

    for (const token of [
      '--bridge-bg: #181818',
      '--bridge-surface: #1f1f1f',
      '--bridge-surface-2: #262626',
      '--bridge-text: #ffffff',
      '--bridge-text-muted: color-mix(in srgb, #ffffff 72%, transparent)',
      '--bridge-border: #3a3a3a',
      '--bridge-error: #f4514c',
      '--bridge-focus: #ffffff',
      '--bridge-control-height: 28px',
      '--bridge-font-size: 12px'
    ]) {
      expect(styles).toContain(token);
    }

    for (const className of [
      'bridge-section',
      'bridge-section--status',
      'bridge-section__title',
      'bridge-status-line',
      'bridge-selection-card',
      'bridge-project-card',
      'bridge-action-button',
      'bridge-drop-target',
      'bridge-status-error'
    ]) {
      expect(styles).toContain(`.${className}`);
      expect(main).toContain(className);
    }

    for (const rawChrome of ['#252525', '#f2f2f2', '#4a4a4a', '#ffb4a8', '#7aa7ff']) {
      expect(styles).not.toContain(rawChrome);
    }
    expect(styles).not.toContain('oklch(');
    expect(styles).not.toMatch(/\nbutton\s*\{/);
    expect(styles).not.toMatch(/\nsection\s*\{/);
  });
});
