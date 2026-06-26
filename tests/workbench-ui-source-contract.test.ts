import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const entryStyleFile = 'apps/web/src/styles.css';
const uiStyleFiles = [
  'apps/web/src/workbench/ui/styles/base.css',
  'apps/web/src/workbench/ui/styles/controls.css',
  'apps/web/src/workbench/ui/styles/fields.css',
  'apps/web/src/workbench/ui/styles/menus.css',
  'apps/web/src/workbench/ui/styles/overlays.css',
  'apps/web/src/workbench/ui/styles/panels.css',
  'apps/web/src/workbench/ui/styles/tokens.css',
  'apps/web/src/workbench/ui/styles/workbench-patterns.css'
];
const featureStyleFiles = [
  'apps/web/src/workbench/styles/shell.css',
  'apps/web/src/workbench/styles/titlebar.css',
  'apps/web/src/workbench/styles/project-open.css',
  'apps/web/src/workbench/styles/explorer.css',
  'apps/web/src/workbench/styles/canvas.css',
  'apps/web/src/workbench/styles/inspector.css',
  'apps/web/src/workbench/styles/settings.css',
  'apps/web/src/workbench/styles/terminal.css',
  'apps/web/src/workbench/styles/integrations.css'
];
const styleFiles = [entryStyleFile, ...uiStyleFiles, ...featureStyleFiles];
const nonCanvasFeatureStyleFiles = featureStyleFiles.filter((file) => !file.endsWith('/canvas.css'));
const rawColorLiteralPattern = /(?:#[0-9a-fA-F]{3,8}\b|rgb\(|oklch\()/;

describe('Workbench UI source contract', () => {
  it('keeps the Web entry stylesheet import-only', () => {
    const imports = css(entryStyleFile).split('\n').map((line) => line.trim()).filter(Boolean);

    expect(imports).toEqual([
      '@import "./workbench/ui/styles/tokens.css";',
      '@import "./workbench/ui/styles/base.css";',
      '@import "./workbench/ui/styles/controls.css";',
      '@import "./workbench/ui/styles/fields.css";',
      '@import "./workbench/ui/styles/panels.css";',
      '@import "./workbench/ui/styles/menus.css";',
      '@import "./workbench/ui/styles/overlays.css";',
      '@import "./workbench/ui/styles/workbench-patterns.css";',
      '@import "./workbench/styles/shell.css";',
      '@import "./workbench/styles/titlebar.css";',
      '@import "./workbench/styles/project-open.css";',
      '@import "./workbench/styles/explorer.css";',
      '@import "./workbench/styles/canvas.css";',
      '@import "./workbench/styles/inspector.css";',
      '@import "./workbench/styles/settings.css";',
      '@import "./workbench/styles/terminal.css";',
      '@import "./workbench/styles/integrations.css";'
    ]);
  });

  it('keeps Workbench style variables in current namespaces', () => {
    const violations = styleFiles.flatMap((file) => (
      css(file)
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

  it('uses final Workbench pattern names for repeated structures', () => {
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const settings = css('apps/web/src/workbench/settings/SettingsPanel.tsx');

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
      '.db-terminal-tab-end-slot',
      '.db-notification-stack',
      '.db-notification-row',
      '.db-settings-section',
      '.db-settings-section__header',
      '.db-form-grid',
      '.db-form-row',
      '.db-action-row',
      '.db-model-card',
      '.db-model-card__header',
      '.db-model-card__fields',
      '.db-secret-field',
      '.db-status-list',
      '.db-project-open',
      '.db-project-open__meta',
      '.db-integration-list',
      '.db-integration-row',
      '.db-integration-row__action',
      '.db-integration-summary'
    ]) {
      expect(patterns).toContain(pattern);
    }

    expect(settings).toContain('className={activePage === item.id ? \'db-nav-row db-nav-row--active\' : \'db-nav-row\'}');
    expect(settings).toContain('className="db-nav-row__icon"');
  });

  it('keeps floating panel shell interaction geometry shared, compact, and isolated from feature scroll', () => {
    const shell = css('apps/web/src/workbench/styles/shell.css');
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const terminal = css('apps/web/src/workbench/styles/terminal.css');
    const workbenchCloseButtonRule = rule(patterns, '.db-workbench-close-button.db-icon-button');
    const floatingPanelCloseRule = rule(shell, '.floating-panel-close-button');

    expect(shell).toContain('grid-template-rows: var(--db-floating-panel-drag-hit-area-height) minmax(0, 1fr);');
    expect(shell).toContain('.floating-panel-close-button');
    expect(shell).toContain('.floating-panel-drag-hit-area');
    expect(shell).toContain('height: var(--db-floating-panel-drag-hit-area-height);');
    expect(shell).toContain('inset: 4px 0 0;');
    expect(workbenchCloseButtonRule).toContain('width: 14px;');
    expect(workbenchCloseButtonRule).toContain('height: 14px;');
    expect(workbenchCloseButtonRule).toContain('border: 0;');
    expect(workbenchCloseButtonRule).toContain('border-radius: 999px;');
    expect(workbenchCloseButtonRule).toContain('background: transparent;');
    expect(workbenchCloseButtonRule).toContain('opacity: 0.42;');
    expect(patterns).toContain('.db-workbench-close-button.db-icon-button:hover:not(:disabled),');
    expect(patterns).toContain('.db-workbench-close-button.db-icon-button:focus-visible');
    expect(floatingPanelCloseRule).toContain('top: 2px;');
    expect(floatingPanelCloseRule).toContain('right: 2px;');
    expect(floatingPanelCloseRule).not.toContain('width:');
    expect(floatingPanelCloseRule).not.toContain('height:');
    expect(floatingPanelCloseRule).not.toContain('border:');
    expect(floatingPanelCloseRule).not.toContain('border-radius:');
    expect(floatingPanelCloseRule).not.toContain('background:');
    expect(floatingPanelCloseRule).not.toContain('opacity:');
    expect(floatingPanelCloseRule).not.toContain('border-color:');
    for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      expect(shell).toContain(`.floating-panel-resize-handle--${direction}`);
    }
    expect(shell).not.toContain('.floating-panel-resize-handle--se::after');
    expect(shell).not.toContain('resize-handle--se::after');
    expect(shell).toContain('cursor: ns-resize;');
    expect(shell).toContain('cursor: ew-resize;');
    expect(shell).toContain('cursor: nesw-resize;');
    expect(shell).toContain('cursor: nwse-resize;');
    expect(shell).toContain('grid-row: 2;');
    expect(shell).toContain('.floating-panel-terminal .floating-panel-body {\n  overflow: visible;\n}');
    expect(terminal).not.toContain('.floating-panel-terminal .floating-panel-body');
    expect(terminal).not.toContain('padding: 0 34px');
  });

  it('keeps Project Explorer content below the shell drag area without a feature spacer', () => {
    const explorer = css('apps/web/src/workbench/styles/explorer.css');
    const projectTree = css('apps/web/src/workbench/project-explorer/ProjectTree.tsx');

    expect(explorer).toContain('padding: 0 4px 10px;');
    expect(explorer).not.toContain('padding: 6px 4px 10px;');
    expect(explorer).not.toContain('padding: 20px 4px 10px;');
    expect(explorer).not.toContain('--tree-depth');
    expect(projectTree).not.toContain('--tree-depth');
    expect(projectTree).not.toContain('data-project-tree-depth');
  });

  it('keeps Settings content flush under the shell drag area', () => {
    const settingsStyles = css('apps/web/src/workbench/styles/settings.css');

    expect(settingsStyles).toContain('padding: 0 14px 14px;');
    expect(settingsStyles).toContain('padding: 0 var(--db-space-3) var(--db-space-3);');
    expect(settingsStyles).toContain('padding: 0 4px 10px 0;');
    expect(settingsStyles).not.toContain('padding: 14px;');
    expect(settingsStyles).not.toContain('padding: var(--db-space-3);');
    expect(settingsStyles).not.toContain('padding: 2px 4px 10px 0;');
  });

  it('keeps every floating panel content surface visually flush with the interaction area', () => {
    const shell = css('apps/web/src/workbench/styles/shell.css');
    const floatingPanelRule = rule(shell, '.floating-panel');
    const floatingPanelBodyRule = rule(shell, '.floating-panel-body');

    expect(floatingPanelRule).toContain('--db-floating-panel-content-bg: var(--db-panel-bg);');
    expect(floatingPanelRule).toContain('background: var(--db-floating-panel-content-bg);');
    expect(floatingPanelBodyRule).toContain('background: var(--db-floating-panel-content-bg);');
    expect(shell).toContain('.floating-panel-inspector,\n.floating-panel-problems {\n  --db-floating-panel-content-bg: var(--db-surface-1);');
    expect(shell).toContain('.floating-panel-settings,\n.floating-panel-terminal {\n  --db-floating-panel-content-bg: var(--db-bg);');
    expect(shell).not.toContain('.floating-panel-inspector .floating-panel-body');
    expect(shell).not.toContain('.floating-panel-problems .floating-panel-body');
    expect(shell).not.toContain('.floating-panel-settings .floating-panel-body');
  });

  it('keeps Terminal tab controls at one height and prevents tab close controls from overlapping the end slot', () => {
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const terminal = css('apps/web/src/workbench/styles/terminal.css');
    const terminalTabCloseRule = rule(patterns, '.db-terminal-tab__close.db-icon-button');

    expect(terminal).toContain('top: calc(-1 * var(--db-floating-panel-drag-hit-area-height));');
    expect(terminal).toContain('height: var(--db-floating-panel-drag-hit-area-height);');
    expect(terminal).toContain('min-height: var(--db-floating-panel-drag-hit-area-height);');
    expect(terminal).toContain('padding: 0 4px;');
    expect(terminal).toContain('align-items: center;');
    expect(patterns).toContain('flex: 0 1 auto;');
    expect(patterns).toContain('flex: 0 0 168px;');
    expect(patterns).toContain('height: var(--db-floating-panel-drag-hit-area-height);');
    expect(patterns).not.toContain('height: 24px;');
    expect(patterns).toContain('.db-terminal-tab__close.db-icon-button');
    expect(terminalTabCloseRule).toContain('top: calc((var(--db-floating-panel-drag-hit-area-height) - 14px) / 2);');
    expect(terminalTabCloseRule).not.toContain('width:');
    expect(terminalTabCloseRule).not.toContain('height:');
    expect(terminalTabCloseRule).not.toContain('border:');
    expect(terminalTabCloseRule).not.toContain('border-radius:');
    expect(terminalTabCloseRule).not.toContain('background:');
    expect(terminalTabCloseRule).not.toContain('color:');
    expect(terminalTabCloseRule).not.toContain('opacity:');
    expect(terminalTabCloseRule).not.toContain('border-color:');
    expect(terminalTabCloseRule).not.toContain('border-radius: var(--db-radius-sm);');
    expect(patterns).not.toMatch(/db-terminal-tab__close\.db-icon-button:hover:not\(:disabled\)\s*\{\n\s*border-color:/);
    expect(patterns).toContain('.db-terminal-tab-end-slot');
    expect(patterns).toContain('.db-terminal-tab-new-button');
  });

  it('keeps reusable Workbench pattern chrome out of feature styles', () => {
    const patternPrefixes = [
      '.db-nav-row',
      '.db-diagnostic',
      '.db-terminal-tab',
      '.db-notification',
      '.db-canvas-node',
      '.db-settings-section',
      '.db-form-',
      '.db-action-row',
      '.db-model-card',
      '.db-secret-field',
      '.db-status-list',
      '.db-project-open',
      '.db-integration',
      '.db-object-property-row'
    ];
    const violations = featureStyleFiles.flatMap((file) => (
      cssRuleBlocks(css(file))
        .map((rule) => rule.selector)
        .filter((selector) => selector.split(',').some((part) => (
          patternPrefixes.some((prefix) => part.trim().startsWith(prefix))
        )))
        .map((selector) => `${file}:${selector}`)
    ));

    expect(violations).toEqual([]);
  });

  it('removes obsolete feature-local Workbench visual classes', () => {
    const obsoleteClasses = [
      'settings-section',
      'settings-section-header',
      'settings-grid',
      'settings-edit-form',
      'settings-actions',
      'settings-row',
      'settings-error',
      'settings-model-card',
      'settings-model-card-header',
      'settings-model-card-fields',
      'settings-model-edit-grid',
      'settings-key-input',
      'settings-key-control',
      'settings-key-visibility',
      'settings-pills',
      'integrations-list',
      'integration-row',
      'integration-row-action',
      'integration-backend-summary',
      'integration-command-preview',
      'terminal-panel__actions',
      'project-open-panel__actions',
      'project-open-panel__path',
      'project-open-panel__error',
      'debrute-cli-status-card',
      'debrute-cli-status-grid',
      'general-settings-grid',
      'general-settings-card',
      'app-update-card',
      'app-update-header',
      'app-update-message',
      'adobe-bridge-target-row'
    ];
    const files = [
      ...featureStyleFiles,
      ...uiStyleFiles,
      'apps/web/src/workbench/adobe-bridge/SendToPhotoshopDialog.tsx',
      'apps/web/src/workbench/settings/SettingsPanel.tsx',
      'apps/web/src/workbench/settings/general/GeneralSettingsPage.tsx',
      'apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage.tsx',
      'apps/web/src/workbench/settings/integrations/IntegrationsSettingsPage.tsx',
      'apps/web/src/workbench/settings/adobe-bridge/AdobeBridgeSettingsPage.tsx',
      'apps/web/src/workbench/project-open/ProjectOpenPanel.tsx',
      'apps/web/src/workbench/terminal/TerminalPanel.tsx'
    ];
    const violations = files.flatMap((file) => (
      obsoleteClasses
        .filter((className) => hasCssClassToken(css(file), className))
        .map((className) => `${file}:${className}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps feature-specific selectors out of Workbench UI style modules', () => {
    const uiStyleSources = uiStyleFiles.map((file) => ({ file, styles: css(file) }));
    const allowedNonDbSelectors = new Set([
      ':root',
      '*',
      '*::before',
      '*::after',
      'html',
      'body',
      '#root',
      'button',
      'input',
      'textarea',
      'select',
      'small',
      '.spin'
    ]);
    const violations = uiStyleSources.flatMap(({ file, styles }) => (
      cssRuleBlocks(styles)
        .flatMap((block) => block.selector.split(',').map((selector) => selector.trim()))
        .filter((selector) => selector.startsWith('.'))
        .filter((selector) => !selector.startsWith('.db-') && !allowedNonDbSelectors.has(selector))
        .map((selector) => `${file}:${selector}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps feature styles from defining primitive chrome systems', () => {
    const allowedSelectors = new Set([
      '.workbench-titlebar__window-controls .db-icon-button',
      '.workbench-titlebar__window-controls .db-icon-button:last-child:hover',
      '.workbench-titlebar__submenu-trigger .db-menu__item-icon',
      '.canvas-feedback-mark .db-icon-button__icon'
    ]);
    const primitiveFragments = [
      '.db-button',
      '.db-icon-button',
      '.db-input',
      '.db-select',
      '.db-textarea',
      '.db-card',
      '.db-panel',
      '.db-menu',
      '.db-status-pill',
      '.db-toolbar',
      '.db-tab'
    ];
    const nativeControlPattern = /(^|[\s>+~])(button|input|textarea|select)(?=[\s.#:[,]|$)/;
    const violations = featureStyleFiles.flatMap((file) => (
      cssRuleBlocks(css(file))
        .flatMap((rule) => rule.selector.split(',').map((selector) => selector.trim()))
        .filter((selector) => !allowedSelectors.has(selector))
        .filter((selector) => primitiveFragments.some((fragment) => selector.includes(fragment)) || nativeControlPattern.test(selector))
        .map((selector) => `${file}:${selector}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps raw non-Canvas chrome values out of feature styles', () => {
    const violations = nonCanvasFeatureStyleFiles.flatMap((file) => (
      cssRuleBlocks(css(file))
        .flatMap((rule) => rule.lines
          .filter(({ text }) => rawColorLiteralPattern.test(text))
          .filter(({ text }) => !(file.endsWith('/titlebar.css') && text.includes('mask-image') && text.includes('#000')))
          .map(({ line, text }) => `${file}:${line}:${rule.selector}:${text.trim()}`))
    ));

    expect(violations).toEqual([]);
  });

  it('keeps primitive imports at the public Workbench UI boundary', () => {
    const sources = [
      'apps/web/src/workbench/settings/SettingsPanel.tsx',
      'apps/web/src/workbench/settings/general/GeneralSettingsPage.tsx',
      'apps/web/src/workbench/settings/debrute-cli/DebruteCliSettingsPage.tsx',
      'apps/web/src/workbench/settings/integrations/IntegrationsSettingsPage.tsx',
      'apps/web/src/workbench/settings/adobe-bridge/AdobeBridgeSettingsPage.tsx',
      'apps/web/src/workbench/project-open/ProjectOpenPanel.tsx',
      'apps/web/src/workbench/project-explorer/ProjectTree.tsx',
      'apps/web/src/workbench/shell/Inspector.tsx',
      'apps/web/src/workbench/terminal/TerminalPanel.tsx',
      'apps/web/src/workbench/canvas/CanvasCardBar.tsx',
      'apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx',
      'apps/web/src/workbench/canvas/CanvasMinimapBar.tsx',
      'apps/web/src/workbench/canvas/CanvasResetLayoutButton.tsx'
    ];
    const violations = sources.flatMap((file) => (
      [...css(file).matchAll(/from ['"](?:\.\.\/)+ui\/(?!index['"])([^'"]+)['"]/g)]
        .map((match) => `${file}:../ui/${match[1]}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps third-party UI implementation details out of feature code', () => {
    const sources = [
      'apps/web/src/workbench/settings/SettingsPanel.tsx',
      'apps/web/src/workbench/project-open/ProjectOpenPanel.tsx',
      'apps/web/src/workbench/project-explorer/ProjectTree.tsx',
      'apps/web/src/workbench/shell/Inspector.tsx',
      'apps/web/src/workbench/terminal/TerminalPanel.tsx',
      'apps/web/src/workbench/canvas/CanvasCardBar.tsx',
      'apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx',
      'apps/web/src/workbench/canvas/CanvasMinimapBar.tsx'
    ];
    const disallowed = ['@radix-ui/', 'antd', '@mui/', '@chakra-ui/', '@mantine/', '@fluentui/', 'bootstrap'];
    const violations = sources.flatMap((file) => (
      disallowed
        .filter((target) => css(file).includes(`from '${target}`) || css(file).includes(`from "${target}`))
        .map((target) => `${file}:${target}`)
    ));

    expect(violations).toEqual([]);
  });

  it('keeps Workbench spin animation owned by the UI base stylesheet only', () => {
    const featureStyles = featureCss();
    const base = css('apps/web/src/workbench/ui/styles/base.css');

    expect(base).toContain('.spin');
    expect(base).toContain('@keyframes db-spin');
    expect(featureStyles).not.toMatch(/\.spin\s*\{/);
    expect(featureStyles).not.toContain('@keyframes spin');
  });

  it('keeps Canvas feedback controls inside the compact floating bar geometry', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');
    const feedbackBarRule = rule(styles, '.canvas-feedback-bar');
    const feedbackBarWithCommentsRule = rule(styles, '.canvas-feedback-bar--has-comment-row');
    const feedbackPrimaryRowRule = rule(styles, '.canvas-feedback-primary-row');
    const feedbackMarkRule = rule(styles, '.canvas-feedback-mark');
    const feedbackMarkIconRule = rule(styles, '.canvas-feedback-mark .db-icon-button__icon');
    const feedbackNoteRule = rule(styles, '.canvas-feedback-comment-pill');
    const feedbackCommentCreatorRule = rule(styles, '.canvas-feedback-comment-creator');
    const feedbackCommentStripRule = rule(styles, '.canvas-feedback-comment-strip');
    const feedbackSource = css('apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx');

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
    const canvasStyles = css('apps/web/src/workbench/styles/canvas.css');
    const shellStyles = css('apps/web/src/workbench/styles/shell.css');
    const cardBarRule = rule(canvasStyles, '.canvas-card-bar');
    const dockRule = rule(shellStyles, '.floating-dock');
    const cardBarSource = css('apps/web/src/workbench/canvas/CanvasCardBar.tsx');
    const dockSource = css('apps/web/src/workbench/shell/FloatingDock.tsx');

    expect(cardBarRule).toContain('height: 28px;');
    expect(cardBarRule).toContain('padding: 0;');
    expect(dockRule).toContain('top: calc(32px + 13px);');
    expect(dockRule).toContain('width: 28px;');
    expect(dockRule).toContain('padding: 0;');
    expect(shellStyles).not.toContain('.floating-dock .db-icon-button');
    expect(cardBarSource).toContain('db-floating-bar canvas-card-bar');
    expect(cardBarSource).toContain('size="sm"');
    expect(dockSource).toContain('size={14}');
    expect(dockSource).not.toContain('size={18}');
    expect(dockSource).not.toContain('db-floating-bar');
  });

  it('keeps lower-left Canvas controls borderless and pattern-owned', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const minimapRule = rule(styles, '.canvas-minimap-bar');
    const resetRule = rule(styles, '.canvas-reset-layout-button');
    const minimapSource = css('apps/web/src/workbench/canvas/CanvasMinimapBar.tsx');
    const resetSource = css('apps/web/src/workbench/canvas/CanvasResetLayoutButton.tsx');

    expect(minimapRule).not.toContain('border: 0;');
    expect(minimapRule).not.toContain('color:');
    expect(resetRule).not.toContain('border: 0;');
    expect(resetRule).not.toContain('color:');
    expect(styles).not.toContain('.canvas-minimap-bar:hover');
    expect(styles).not.toContain('.canvas-minimap-bar[aria-pressed="true"]');
    expect(styles).not.toContain('.canvas-minimap-bar:disabled');
    expect(styles).not.toContain('.canvas-reset-layout-button:hover');
    expect(styles).not.toContain('.canvas-reset-layout-button:disabled');
    expect(patterns).toContain('.db-canvas-control:hover:not(:disabled)');
    expect(patterns).toContain('.db-canvas-control[aria-pressed="true"]');
    expect(patterns).toContain('.db-canvas-control:disabled');
    expect(minimapSource).toContain('db-floating-bar canvas-minimap-bar');
    expect(resetSource).toContain('db-floating-bar canvas-reset-layout-button');
  });

  it('styles invalid state for every Workbench field control', () => {
    const fields = css('apps/web/src/workbench/ui/styles/fields.css');

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
    const tokens = css('apps/web/src/workbench/ui/styles/tokens.css');

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
    const tokens = css('apps/web/src/workbench/ui/styles/tokens.css');
    const controls = css('apps/web/src/workbench/ui/styles/controls.css');

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
    expect(rule(controls, '.db-button--ghost')).toContain('color: var(--db-text);');
    expect(rule(controls, '.db-icon-button--ghost')).toContain('color: var(--db-text);');
  });

  it('does not keep success as a text-buffer status tone after saved state stops rendering', () => {
    const floatingTextEditorStatus = css('apps/web/src/workbench/services/textEditorWindows.ts');
    const canvasTextNodeStatus = css('apps/web/src/workbench/canvas/CanvasNodeContent.tsx');

    expect(floatingTextEditorStatus).not.toMatch(/TextBufferStatusTone\s*=\s*[^;]*'success'/);
    expect(functionBlock(floatingTextEditorStatus, 'textBufferStatus')).not.toContain("'success'");
    expect(functionBlock(canvasTextNodeStatus, 'textBufferStatus')).not.toContain("'success'");
  });

  it('keeps Settings headers structural instead of copy-bearing chrome', () => {
    const settings = css('apps/web/src/workbench/settings/SettingsPanel.tsx');
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const sectionHeader = functionBlock(settings, 'SettingsSectionHeader');

    expect(sectionHeader).toContain('<header className="db-settings-section__header">');
    expect(sectionHeader).toContain('<h2>{title}</h2>');
    expect(sectionHeader).not.toContain('<p');
    expect(sectionHeader).not.toContain('<span');
    expect(patterns).not.toMatch(/\.db-settings-section__header\s+(?:span|p)\b/);
  });

  it('keeps Canvas node feature CSS scoped to geometry and media rendering', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');
    const featureOwnedPrefixes = [
      '.canvas-node-element',
      '.canvas-node-presentation',
      '.canvas-node-preview',
      '.canvas-node-image-reserved',
      '.canvas-node-resize',
      '.canvas-text-node',
      '.canvas-text-body',
      '.canvas-text-message',
      '.canvas-text-editor',
      '.canvas-image-feedback',
      '.canvas-feedback'
    ];
    const violations = cssRuleBlocks(styles)
      .flatMap((ruleBlock) => ruleBlock.selector.split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('canvas-node') || selector.includes('canvas-text') || selector.includes('canvas-feedback'))
      .filter((selector) => !featureOwnedPrefixes.some((prefix) => selector.startsWith(prefix)));

    expect(violations).toEqual([]);
  });

  it('keeps canvas text styling owned by the live CodeMirror editor surface', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');

    expect(styles).toContain('--canvas-text-editor-font-family');
    expect(styles).toContain('var(--canvas-text-editor-line-height)');
    expect(styles).toContain('.canvas-text-editor--edit');
    expect(styles).not.toContain(`.canvas-text-editor--${'pre'}${'view'}`);
    expect(styles).not.toContain(`.tok-${'key'}${'word'}`);
  });

  it('keeps live canvas text editors on text editing cursors', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');
    const editorCursorRule = rule(styles, '.canvas-text-editor--edit .cm-scroller, .canvas-text-editor--edit .cm-content, .canvas-text-editor--edit .cm-line');
    const gutterCursorRule = rule(styles, '.canvas-text-editor--edit .cm-gutters, .canvas-text-editor--edit .cm-gutterElement');

    expect(editorCursorRule).toContain('cursor: text;');
    expect(gutterCursorRule).toContain('cursor: default;');
  });

  it('does not force CodeMirror edit gutter measurement elements to line height', () => {
    const styles = css('apps/web/src/workbench/styles/canvas.css');
    const editGutterRule = rule(styles, '.canvas-text-editor .cm-gutterElement');

    expect(editGutterRule).not.toContain('min-height:');
    expect(styles).not.toContain(`canvas-text-editor__gutter-${'measure'}`);
  });

  it('keeps Canvas generic node labels single-line and ellipsized', () => {
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const labelRule = patterns.match(/\.db-canvas-node-generic strong,\n\.db-canvas-node-generic span\s*\{[^}]*\}/)?.[0] ?? '';

    expect(labelRule).toContain('overflow: hidden;');
    expect(labelRule).toContain('text-overflow: ellipsis;');
    expect(labelRule).toContain('white-space: nowrap;');
  });

  it('owns Canvas node chrome through db-canvas-node pattern selectors', () => {
    const patterns = css('apps/web/src/workbench/ui/styles/workbench-patterns.css');
    const violations = cssRuleBlocks(patterns)
      .flatMap((ruleBlock) => ruleBlock.selector.split(',').map((selector) => selector.trim()))
      .filter((selector) => selector.includes('canvas-node') && !selector.startsWith('.db-canvas-node-'));

    expect(violations).toEqual([]);
  });

  it('keeps notifications on shared primitives and Workbench patterns', () => {
    const notificationStack = css('apps/web/src/workbench/shell/NotificationStack.tsx');

    expect(notificationStack).toContain('className="db-notification-stack"');
    expect(notificationStack).toContain('className="db-notification-row"');
    expect(notificationStack).toContain('<Card');
  });

  it('styles the Workbench title bar as drag chrome and not a card', () => {
    const styles = css('apps/web/src/workbench/styles/titlebar.css');

    expect(styles).toContain('.workbench-titlebar');
    expect(styles).toContain('-webkit-app-region: drag');
    expect(styles).toContain('backdrop-filter');
    expect(styles).toContain('linear-gradient');
    expect(styles).not.toContain('.workbench-titlebar .db-card');
  });
});

function css(file: string): string {
  return readFileSync(file, 'utf8');
}

function featureCss(): string {
  return featureStyleFiles.map((file) => css(file)).join('\n');
}

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

function rule(styles: string, selector: string): string {
  return cssRuleBlocks(styles).find((block) => block.selector === selector)?.lines.map(({ text }) => text.trim()).join('\n') ?? '';
}

function hasCssClassToken(source: string, className: string): boolean {
  return new RegExp(`(^|[^\\w-])${escapeRegExp(className)}($|[^\\w-])`).test(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function functionBlock(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) {
    return '';
  }
  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction < 0 ? undefined : nextFunction);
}
