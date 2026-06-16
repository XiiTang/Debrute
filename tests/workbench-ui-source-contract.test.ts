import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const legacyTokenNames = 'bg|bg-elevated|bg-panel|bg-soft|text|muted|subtle|border|accent|accent-strong|warn|danger|info|radius';
const legacyTokenPattern = new RegExp(`(?:var\\(--(?:${legacyTokenNames})\\)|--(?:${legacyTokenNames}):)`);

const styleFiles = [
  'apps/web/src/styles.css',
  'apps/web/src/workbench/ui/styles/base.css',
  'apps/web/src/workbench/ui/styles/controls.css',
  'apps/web/src/workbench/ui/styles/fields.css',
  'apps/web/src/workbench/ui/styles/menus.css',
  'apps/web/src/workbench/ui/styles/overlays.css',
  'apps/web/src/workbench/ui/styles/panels.css',
  'apps/web/src/workbench/ui/styles/tokens.css',
  'apps/web/src/workbench/ui/styles/workbench-patterns.css'
];
const rawColorLiteralPattern = /(?:#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\()/;
const joinText = (...parts: string[]) => parts.join('');

describe('Workbench UI source contract', () => {
  it('uses only final Workbench UI token names in current stylesheets', () => {
    const violations = styleFiles.flatMap((file) => (
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => legacyTokenPattern.test(text))
        .map(({ file, line, text }) => `${file}:${line}:${text.trim()}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps settings navigation control chrome in Workbench UI patterns', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    expect(styles).not.toMatch(/\.settings-directory\s+button\b/);
    expect(styles).not.toMatch(/\.settings-directory\s+button\./);
    expect(styles).not.toMatch(/\.settings-directory\s+button:/);
  });

  it('keeps floating text editor chrome on Workbench UI primitives', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const source = readFileSync('apps/web/src/workbench/shell/FloatingTextEditorWindow.tsx', 'utf8');

    expect(source).not.toContain('<button');
    expect(styles).not.toMatch(/\.floating-text-editor-window\s*\{/);
    expect(styles).not.toMatch(/\.floating-text-editor-header\s+button\b/);
    expect(styles).not.toMatch(/\.floating-text-editor-header\s+button:/);
  });

  it('does not keep active-class compatibility for primitive pressed state', () => {
    const controls = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');
    const sources = [
      'apps/web/src/workbench/shell/FloatingDock.tsx',
      'apps/web/src/workbench/canvas/CanvasMinimapBar.tsx',
      'apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx'
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    const terminalPanel = readFileSync('apps/web/src/workbench/terminal/TerminalPanel.tsx', 'utf8');

    expect(controls).not.toContain('.db-icon-button.active');
    expect(sources).not.toContain(" active'");
    expect(sources).not.toContain(' active"');
    expect(sources).not.toContain("'active'");
    expect(terminalPanel).not.toContain(joinText('terminal-panel__tab', '--active'));
  });

  it('keeps Workbench spin animation owned by the UI base stylesheet only', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const base = readFileSync('apps/web/src/workbench/ui/styles/base.css', 'utf8');

    expect(base).toContain('.spin');
    expect(base).toContain('@keyframes db-spin');
    expect(styles).not.toMatch(/\.spin\s*\{/);
    expect(styles).not.toContain('@keyframes spin');
  });

  it('keeps Canvas feedback controls inside the compact floating bar geometry', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const feedbackBarRule = styles.match(/\.canvas-feedback-bar\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackNoteRule = styles.match(/\.canvas-feedback-note\s*\{[^}]*\}/)?.[0] ?? '';

    expect(feedbackBarRule).toContain('height: 32px;');
    expect(feedbackBarRule).toContain('padding: 3px 4px;');
    expect(feedbackNoteRule).toContain('height: 24px;');
    expect(feedbackNoteRule).toContain('min-height: 24px;');
    expect(feedbackNoteRule).toContain('padding: 0 7px;');
  });

  it('styles invalid state for every Workbench field control', () => {
    const fields = readFileSync('apps/web/src/workbench/ui/styles/fields.css', 'utf8');

    for (const selector of [
      '.db-input[aria-invalid="true"]',
      '.db-select[aria-invalid="true"]',
      '.db-textarea[aria-invalid="true"]',
      '.db-field--invalid .db-input',
      '.db-field--invalid .db-select',
      '.db-field--invalid .db-textarea'
    ]) {
      expect(fields).toContain(selector);
    }
  });

  it('defines the final visual token families used by Workbench chrome', () => {
    const tokens = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');

    for (const token of [
      '--db-canvas-bg',
      '--db-canvas-grid',
      '--db-selection',
      '--db-selection-muted',
      '--db-floating-bg',
      '--db-danger-bg',
      '--db-shadow-floating',
      '--db-duration-fast',
      '--db-ease-standard'
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it('keeps the final neutral Workbench background and white foreground contract', () => {
    const tokens = readFileSync('apps/web/src/workbench/ui/styles/tokens.css', 'utf8');
    const controls = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');

    for (const declaration of [
      '--db-bg: #181818;',
      '--db-surface-1: #1f1f1f;',
      '--db-surface-2: #262626;',
      '--db-surface-3: #303030;',
      '--db-canvas-bg: #181818;',
      '--db-text: #ffffff;'
    ]) {
      expect(tokens).toContain(declaration);
    }

    expect(tokens).toContain('--db-canvas-grid: color-mix(in srgb, #ffffff 8%, transparent);');
    expect(tokens).not.toMatch(/--db-canvas-bg:\s*oklch\(0\.9/);
    expect(controlRule(controls, '.db-button--ghost')).toContain('color: var(--db-text);');
    expect(controlRule(controls, '.db-icon-button--ghost')).toContain('color: var(--db-text);');
  });

  it('does not keep success as a text-buffer status tone after saved state stops rendering', () => {
    const floatingTextEditorStatus = readFileSync('apps/web/src/workbench/services/textEditorWindows.ts', 'utf8');
    const canvasTextNodeStatus = readFileSync('apps/web/src/workbench/canvas/CanvasNodeContent.tsx', 'utf8');

    expect(floatingTextEditorStatus).not.toMatch(/TextBufferStatusTone\s*=\s*[^;]*'success'/);
    expect(functionBlock(floatingTextEditorStatus, 'textBufferStatus')).not.toContain("'success'");
    expect(functionBlock(canvasTextNodeStatus, 'textBufferStatus')).not.toContain("'success'");
  });

  it('does not keep explanatory Settings chrome copy or decorative eyebrow hooks', () => {
    const settings = readFileSync('apps/web/src/workbench/settings/SettingsPanel.tsx', 'utf8');
    const integrations = readFileSync('apps/web/src/workbench/settings/integrations/IntegrationsSettingsPage.tsx', 'utf8');
    const cli = readFileSync('apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage.tsx', 'utf8');
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    for (const text of [
      joinText('Model routing', ' and provider credentials'),
      joinText('Generation endpoints', ' and API keys'),
      joinText('Optional local', ' capabilities'),
      joinText('Command install', ' and Skills sync'),
      'Configure chat providers, discovery, and the default model route.',
      joinText('Manage image generation model', ' endpoints and credentials.'),
      joinText('Manage video generation model', ' endpoints and credentials.'),
      joinText('Debrute detects optional local capabilities from PATH', ' and shows backend command previews without executing them.')
    ]) {
      expect(`${settings}\n${integrations}\n${cli}`).not.toContain(text);
    }

    expect(styles).not.toContain(joinText('.settings-section-header', ' span'));
    expect(styles).not.toContain(joinText('.settings-section-header', ' p'));
  });

  it('does not keep non-canvas chrome raw colors in the feature stylesheet', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    for (const rawChromeValue of [
      '#0b0d12',
      '#10141c',
      'rgb(23 26 31 / 98%)',
      'oklch(0.78 0.12 25)',
      '#8bd5a9',
      'rgb(10 12 12 / 72%)',
      'rgb(90 98 112 / 78%)',
      'rgb(20 22 26 / 94%)',
      'oklch(0.84 0.13 82)'
    ]) {
      expect(styles, rawChromeValue).not.toContain(rawChromeValue);
    }
  });

  it('does not keep raw color or shadow literals in non-Canvas feature CSS rules', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const violations = cssRuleBlocks(styles)
      .filter((rule) => !rule.selector.includes('.canvas-'))
      .flatMap((rule) => rule.lines
        .filter(({ text }) => rawColorLiteralPattern.test(text))
        .map(({ line, text }) => `${line}:${rule.selector}:${text.trim()}`));

    expect(violations).toEqual([]);
  });

  it('keeps Canvas node chrome tokenized without raw selection or surface literals', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    for (const rawCanvasChrome of [
      joinText('#5e', '8eff'),
      joinText('#2c', '3036'),
      joinText('rgb(28 ', '31 36 / 38%)'),
      joinText('rgb(17 19 23', ' / 96%)'),
      joinText('rgb(24 ', '27 32 / 96%)'),
      joinText('rgb(24 ', '18 20 / 92%)'),
      joinText('rgb(24 ', '17 17 / 88%)'),
      joinText('rgb(0 0 0', ' / 40%)')
    ]) {
      expect(styles, rawCanvasChrome).not.toContain(rawCanvasChrome);
    }
  });

  it('keeps Canvas generic node labels single-line and ellipsized', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const labelRule = styles.match(/\.canvas-node-generic strong,\n\.canvas-node-generic span\s*\{[^}]*\}/)?.[0] ?? '';

    expect(labelRule).toContain('overflow: hidden;');
    expect(labelRule).toContain('text-overflow: ellipsis;');
    expect(labelRule).toContain('white-space: nowrap;');
  });

  it('keeps Canvas chrome shadows tokenized and scoped to Workbench stat classes', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const canvasChromeSelectors = new Set([
      '.canvas-card-bar',
      '.canvas-minimap-bar',
      '.canvas-minimap-panel',
      '.canvas-empty-state'
    ]);
    const violations = cssRuleBlocks(styles)
      .filter((rule) => canvasChromeSelectors.has(rule.selector))
      .flatMap((rule) => rule.lines
        .filter(({ text }) => text.trim().startsWith('box-shadow:') && !text.trim().startsWith('box-shadow: var(--db-'))
        .map(({ line, text }) => `${line}:${rule.selector}:${text.trim()}`));

    expect(violations).toEqual([]);
  });

  it('keeps empty actions and notifications on shared primitives without duplicate chrome', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const canvasEditor = readFileSync('apps/web/src/workbench/canvas/CanvasEditor.tsx', 'utf8');
    const workbenchApp = readFileSync('apps/web/src/workbench/WorkbenchApp.tsx', 'utf8');
    const notificationStack = readFileSync('apps/web/src/workbench/shell/NotificationStack.tsx', 'utf8');

    expect(styles).not.toMatch(/\.empty-action\b/);
    expect(canvasEditor).not.toContain('className="empty-action"');
    expect(workbenchApp).not.toContain('className="empty-action"');
    expect(styles).not.toMatch(/\.notification\s*\{/);
    expect(notificationStack).not.toContain('className="notification"');
  });

  it('keeps feature CSS from defining local Workbench control systems', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const localControlSelectors = [
      joinText('.terminal-panel__actions', ' .db-icon-button'),
      joinText('.canvas-text-titlebar', ' .db-icon-button'),
      joinText('.floating-text-editor-header', ' .db-icon-button'),
      joinText('.settings-section', ' .db-card strong'),
      joinText('.settings-section', ' .db-card small'),
      joinText('.settings-model-edit-grid', ' .db-input'),
      joinText('.settings-key-input', ' .db-input')
    ];

    for (const selector of localControlSelectors) {
      expect(styles).not.toContain(selector);
    }
  });

  it('does not keep unused stylesheet fragments from removed Workbench UI paths', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    for (const selector of [
      '.settings-list',
      '.settings-edit-card-header',
      '.settings-model-card-footer',
      '.integration-confirm-backdrop',
      '.integration-confirm-dialog',
      '.integration-confirm-close'
    ]) {
      expect(styles).not.toContain(selector);
    }
  });
});

function cssRuleBlocks(styles: string): Array<{
  selector: string;
  lines: Array<{ line: number; text: string }>;
}> {
  const rules: Array<{
    selector: string;
    lines: Array<{ line: number; text: string }>;
  }> = [];
  let selector: string | undefined;
  let lines: Array<{ line: number; text: string }> = [];
  styles.split('\n').forEach((text, index) => {
    if (selector === undefined) {
      if (text.includes('{')) {
        selector = text.slice(0, text.indexOf('{')).trim();
        lines = [];
      }
      return;
    }
    if (text.includes('}')) {
      rules.push({ selector, lines });
      selector = undefined;
      lines = [];
      return;
    }
    lines.push({ line: index + 1, text });
  });
  return rules;
}

function controlRule(styles: string, selector: string): string {
  return cssRuleBlocks(styles).find((rule) => rule.selector === selector)?.lines.map(({ text }) => text.trim()).join('\n') ?? '';
}

function functionBlock(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) {
    return '';
  }
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction < 0 ? undefined : nextFunction);
}
