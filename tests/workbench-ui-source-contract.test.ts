import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

describe('Workbench UI source contract', () => {
  it('keeps Workbench style variables in current namespaces', () => {
    const violations = styleFiles.flatMap((file) => (
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .flatMap(({ file, line, text }) => (
          [...text.matchAll(/(^|[^\w-])(--[a-zA-Z0-9-]+)(?=\s*:|\))/g)]
            .map((match) => match[2])
            .filter((token) => !token.startsWith('--db-') && !token.startsWith('--canvas-') && !token.startsWith('--tree-'))
            .map((token) => `${file}:${line}:${token}`)
        ))
    ));

    expect(violations).toEqual([]);
  });

  it('keeps settings navigation control chrome in Workbench UI patterns', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    expect(styles).not.toMatch(/\.settings-directory\s+button\b/);
    expect(styles).not.toMatch(/\.settings-directory\s+button\./);
    expect(styles).not.toMatch(/\.settings-directory\s+button:/);
  });

  it('uses final Workbench pattern names for repeated structures', () => {
    const patterns = readFileSync('apps/web/src/workbench/ui/styles/workbench-patterns.css', 'utf8');
    const settings = readFileSync('apps/web/src/workbench/settings/SettingsPanel.tsx', 'utf8');

    for (const pattern of [
      '.db-tree-row',
      '.db-nav-row',
      '.db-nav-row__icon',
      '.db-object-properties',
      '.db-diagnostic-list',
      '.db-diagnostic-row',
      '.db-floating-bar',
      '.db-terminal-tabs',
      '.db-terminal-tab',
      '.db-notification-stack',
      '.db-notification-row'
    ]) {
      expect(patterns).toContain(pattern);
    }

    expect(settings).toContain('className={activePage === item.id ? \'db-nav-row db-nav-row--active\' : \'db-nav-row\'}');
    expect(settings).toContain('className="db-nav-row__icon"');
  });

  it('keeps reusable Workbench pattern chrome out of the feature stylesheet', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const patternPrefixes = [
      '.db-nav-row',
      '.db-diagnostic',
      '.db-terminal-tab',
      '.db-notification',
      '.db-canvas-node'
    ];

    const violations = cssRuleBlocks(styles)
      .map((rule) => rule.selector)
      .filter((selector) => selector.split(',').some((part) => (
        patternPrefixes.some((prefix) => part.trim().startsWith(prefix))
      )));

    expect(violations).toEqual([]);
  });

  it('keeps floating text editor chrome on Workbench UI primitives', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const source = readFileSync('apps/web/src/workbench/shell/FloatingTextEditorWindow.tsx', 'utf8');

    expect(source).not.toContain('<button');
    expect(styles).not.toMatch(/\.floating-text-editor-window\s*\{/);
    expect(styles).not.toMatch(/\.floating-text-editor-header\s+button\b/);
    expect(styles).not.toMatch(/\.floating-text-editor-header\s+button:/);
  });

  it('uses primitive ARIA pressed state for Workbench toggles', () => {
    const controls = readFileSync('apps/web/src/workbench/ui/styles/controls.css', 'utf8');
    const sources = [
      'apps/web/src/workbench/shell/FloatingDock.tsx',
      'apps/web/src/workbench/canvas/CanvasMinimapBar.tsx',
      'apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx'
    ].map((file) => readFileSync(file, 'utf8')).join('\n');
    const terminalPanel = readFileSync('apps/web/src/workbench/terminal/TerminalPanel.tsx', 'utf8');

    expect(controls).toContain('.db-icon-button[aria-pressed="true"]');
    expect(sources).toContain('pressed=');
    expect(terminalPanel).toContain('active={session.id === state.activeSessionId}');
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
    const feedbackBarWithCommentsRule = styles.match(/\.canvas-feedback-bar--has-comment-row\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackPrimaryRowRule = styles.match(/\.canvas-feedback-primary-row\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackMarkRule = styles.match(/\.canvas-feedback-mark\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackMarkIconRule = styles.match(/\.canvas-feedback-mark \.db-icon-button__icon\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackNoteRule = styles.match(/\.canvas-feedback-comment-pill\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackCommentCreatorRule = styles.match(/\.canvas-feedback-comment-creator\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackCommentStripRule = styles.match(/\.canvas-feedback-comment-strip\s*\{[^}]*\}/)?.[0] ?? '';
    const feedbackSource = readFileSync('apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx', 'utf8');

    expect(feedbackBarRule).toContain('grid-template-rows: 30px;');
    expect(feedbackBarRule).toContain('gap: 2px;');
    expect(feedbackBarRule).toContain('padding: 3px;');
    expect(feedbackBarWithCommentsRule).toContain('grid-template-rows: 30px 36px;');
    expect(feedbackMarkRule).toContain('width: 28px;');
    expect(feedbackMarkRule).toContain('height: 28px;');
    expect(feedbackMarkRule).toContain('border: 0;');
    expect(feedbackMarkIconRule).toContain('transform: translateY(-0.5px);');
    expect(feedbackNoteRule).toContain('height: 30px;');
    expect(feedbackNoteRule).not.toContain('min-height: 30px;');
    expect(feedbackNoteRule).toContain('padding: 5px 30px 5px 12px;');
    expect(feedbackPrimaryRowRule).toContain('grid-template-columns: max-content 90px;');
    expect(feedbackCommentCreatorRule).toContain('justify-self: start;');
    expect(feedbackCommentStripRule).toContain('padding: 3px 2px 3px 0;');
    expect(feedbackSource).toContain('db-floating-bar canvas-feedback-bar');
  });

  it('keeps Canvas cards and dock icons on the compact control rhythm', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const cardBarRule = styles.match(/\.canvas-card-bar\s*\{[^}]*\}/)?.[0] ?? '';
    const cardControlRule = styles.match(/\.canvas-card,\n\.canvas-card-add,\n\.canvas-card-menu-button\s*\{[^}]*\}/)?.[0] ?? '';
    const cardActionRule = styles.match(/\.canvas-card-menu-button,\n\.canvas-card-add\s*\{[^}]*\}/)?.[0] ?? '';
    const dockRule = styles.match(/\.floating-dock\s*\{[^}]*\}/)?.[0] ?? '';
    const cardBarSource = readFileSync('apps/web/src/workbench/canvas/CanvasCardBar.tsx', 'utf8');
    const dockSource = readFileSync('apps/web/src/workbench/shell/FloatingDock.tsx', 'utf8');

    expect(cardBarRule).toContain('height: 28px;');
    expect(cardBarRule).toContain('padding: 0;');
    expect(cardControlRule).toContain('height: 28px;');
    expect(cardControlRule).not.toContain('min-height: 28px;');
    expect(cardControlRule).toContain('border: 0;');
    expect(cardActionRule).toContain('width: 28px;');
    expect(dockRule).toContain('top: calc(32px + 13px);');
    expect(dockRule).toContain('width: 28px;');
    expect(dockRule).toContain('padding: 0;');
    expect(styles).not.toContain('.floating-dock .db-icon-button');
    expect(cardBarSource).toContain('size="sm"');
    expect(cardBarSource).not.toContain('db-floating-bar');
    expect(dockSource).toContain('size={14}');
    expect(dockSource).not.toContain('size={18}');
    expect(dockSource).not.toContain('db-floating-bar');
  });

  it('keeps lower-left Canvas controls borderless', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const minimapRule = styles.match(/\.canvas-minimap-bar\s*\{[^}]*\}/)?.[0] ?? '';
    const resetRule = styles.match(/\.canvas-reset-layout-button\s*\{[^}]*\}/)?.[0] ?? '';
    const minimapSource = readFileSync('apps/web/src/workbench/canvas/CanvasMinimapBar.tsx', 'utf8');
    const resetSource = readFileSync('apps/web/src/workbench/canvas/CanvasResetLayoutButton.tsx', 'utf8');

    expect(minimapRule).toContain('border: 0;');
    expect(styles).toContain('.canvas-minimap-bar[aria-pressed="true"] {\n  outline: 0;\n}');
    expect(resetRule).toContain('border: 0;');
    expect(minimapSource).not.toContain('db-floating-bar canvas-minimap-bar');
    expect(resetSource).not.toContain('db-floating-bar canvas-reset-layout-button');
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
      '--db-bg',
      '--db-surface-1',
      '--db-surface-2',
      '--db-surface-3',
      '--db-canvas-bg',
      '--db-canvas-grid',
      '--db-text',
      '--db-text-muted',
      '--db-border',
      '--db-selection',
      '--db-selection-muted',
      '--db-floating-bg',
      '--db-danger-bg',
      '--db-control-xs',
      '--db-control-sm',
      '--db-control-md',
      '--db-radius-sm',
      '--db-shadow-floating',
      '--db-focus-ring',
      '--db-duration-fast',
      '--db-ease-standard',
      '--db-z-canvas',
      '--db-z-overlays'
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

  it('keeps Settings headers structural instead of copy-bearing chrome', () => {
    const settings = readFileSync('apps/web/src/workbench/settings/SettingsPanel.tsx', 'utf8');
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const sectionHeader = functionBlock(settings, 'SettingsSectionHeader');

    expect(sectionHeader).toContain('<header className="settings-section-header">');
    expect(sectionHeader).toContain('<h2>{title}</h2>');
    expect(sectionHeader).not.toContain('<p');
    expect(sectionHeader).not.toContain('<span');
    expect(styles).not.toMatch(/\.settings-section-header\s+(?:span|p)\b/);
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

  it('keeps Canvas node feature CSS scoped to geometry and media rendering', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const featureOwnedPrefixes = [
      '.canvas-node-element',
      '.canvas-node-presentation',
      '.canvas-node-preview',
      '.canvas-node-image-reserved',
      '.canvas-node-resize',
      '.canvas-text-node',
      '.canvas-text-body',
      '.canvas-text-message',
      '.canvas-monaco-editor'
    ];
    const violations = cssRuleBlocks(styles)
      .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('canvas-node') || selector.includes('canvas-text'))
      .filter((selector) => !featureOwnedPrefixes.some((prefix) => selector.startsWith(prefix)));

    expect(violations).toEqual([]);
  });

  it('keeps Canvas generic node labels single-line and ellipsized', () => {
    const patterns = readFileSync('apps/web/src/workbench/ui/styles/workbench-patterns.css', 'utf8');
    const labelRule = patterns.match(/\.db-canvas-node-generic strong,\n\.db-canvas-node-generic span\s*\{[^}]*\}/)?.[0] ?? '';

    expect(labelRule).toContain('overflow: hidden;');
    expect(labelRule).toContain('text-overflow: ellipsis;');
    expect(labelRule).toContain('white-space: nowrap;');
  });

  it('owns Canvas node chrome through db-canvas-node pattern selectors', () => {
    const patterns = readFileSync('apps/web/src/workbench/ui/styles/workbench-patterns.css', 'utf8');
    const violations = cssRuleBlocks(patterns)
      .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('canvas-node') && !selector.startsWith('.db-canvas-node-'));

    expect(violations).toEqual([]);
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

  it('keeps notifications on shared primitives and Workbench patterns', () => {
    const notificationStack = readFileSync('apps/web/src/workbench/shell/NotificationStack.tsx', 'utf8');

    expect(notificationStack).toContain('className="db-notification-stack"');
    expect(notificationStack).toContain('className="db-notification-row"');
    expect(notificationStack).toContain('<Card');
  });

  it('keeps feature CSS from defining local Workbench control systems', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');
    const localControlSelectors = [
      '.terminal-panel__actions .db-icon-button',
      '.db-canvas-node-titlebar .db-icon-button',
      '.floating-text-editor-header .db-icon-button',
      '.settings-section .db-card strong',
      '.settings-section .db-card small',
      '.settings-model-edit-grid .db-input',
      '.settings-key-input .db-input',
      '.settings-key-visibility.db-icon-button',
      '.canvas-card-rename-form .db-input',
      '.canvas-card-rename-form .db-menu__item',
      '.floating-dock .db-icon-button'
    ];

    for (const selector of localControlSelectors) {
      expect(styles).not.toContain(selector);
    }
  });

  it('styles the Workbench title bar as drag chrome and not a card', () => {
    const styles = readFileSync('apps/web/src/styles.css', 'utf8');

    expect(styles).toContain('.workbench-titlebar');
    expect(styles).toContain('-webkit-app-region: drag');
    expect(styles).toContain('backdrop-filter');
    expect(styles).toContain('linear-gradient');
    expect(styles).not.toContain('.workbench-titlebar .db-card');
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
