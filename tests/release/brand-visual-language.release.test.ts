import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('brand visual language', () => {
  const root = process.cwd();

  it('ships the complete local type system and centralized material kit', () => {
    for (const asset of [
      'assets/fonts/SmileySans-Oblique.woff2',
      'assets/fonts/NotoSansSC-Regular.woff2',
      'assets/fonts/NotoSansSC-Semibold.woff2',
      'assets/fonts/NotoSansSC-Bold.woff2',
      'assets/fonts/NotoSansMonoCJKsc-Regular.woff2',
      'assets/fonts/NotoSansMonoCJKsc-Bold.woff2',
      'assets/brand/materials/paper-grain.svg',
      'assets/brand/materials/cut-large.svg',
      'assets/brand/materials/cut-medium.svg',
      'assets/brand/materials/cut-small.svg'
    ]) {
      expect(statSync(join(root, asset)).size, asset).toBeGreaterThan(0);
    }

    const tokens = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/tokens.css'), 'utf8');
    expect(tokens).toContain('--db-font-display: "Smiley Sans"');
    expect(tokens).toContain('--db-font-functional: "Noto Sans SC"');
    expect(tokens).toContain('--db-font-technical: "Noto Sans Mono CJK SC"');
    expect(tokens).toContain('--db-paper-grain-mask:');
    expect(tokens).toContain('--db-paper-grain-tint:');
    expect(tokens).toContain('--db-paper-grain-opacity: 0.025');
    expect(tokens).toContain('--db-paper-mask-large:');
    expect(tokens).toContain(':root[data-theme="light"]');
    expect(tokens).toContain(':root[data-theme="dark"]');

    const grain = readFileSync(join(root, 'assets/brand/materials/paper-grain.svg'), 'utf8');
    expect(grain).toContain('fill="#fff"');
    expect(grain).not.toContain('opacity=');
    expect(readFileSync(join(root, 'assets/brand/materials/cut-large.svg'), 'utf8'))
      .toContain('M0 .2L25 0');
    expect(readFileSync(join(root, 'assets/brand/materials/cut-medium.svg'), 'utf8'))
      .toContain('M0 .15L33 0');
    expect(readFileSync(join(root, 'assets/brand/materials/cut-small.svg'), 'utf8'))
      .toContain('M0 .2L50 0');

    const panels = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/panels.css'), 'utf8');
    const menus = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/menus.css'), 'utf8');
    const controls = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/controls.css'), 'utf8');
    const canvas = readFileSync(join(root, 'apps/web/src/workbench/styles/canvas.css'), 'utf8');
    expect(panels.match(/\.db-panel::before\s*\{[\s\S]*?\}/)?.[0])
      .toContain('mask-image: var(--db-paper-mask-large)');
    expect(menus.match(/\.db-menu::before\s*\{[\s\S]*?\}/)?.[0])
      .toContain('mask-image: var(--db-paper-mask-medium)');
    expect(controls.match(/\.db-button--primary::before\s*\{[\s\S]*?\}/)?.[0])
      .toContain('mask-image: var(--db-paper-mask-small)');
    expect(canvas.match(/\.db-floating-bar::before\s*\{[\s\S]*?\}/)?.[0])
      .toContain('mask-image: var(--db-paper-mask-medium)');
    for (const [css, selector] of [
      [panels, '.db-panel'],
      [menus, '.db-menu'],
      [controls, '.db-button--primary'],
      [canvas, '.db-floating-bar']
    ] as const) {
      const rules = [...css.matchAll(new RegExp(
        `${escapeRegExp(selector)}\\s*\\{[\\s\\S]*?\\}`,
        'g'
      ))].map((match) => match[0]).join('\n');
      expect(rules, selector).toContain('box-shadow:');
      expect(rules, selector).not.toContain('mask-image:');
    }
    for (const css of [panels, menus, canvas]) {
      expect(css).toContain('background: var(--db-paper-grain-tint)');
      expect(css).toContain('mask-image: var(--db-paper-grain-mask)');
    }
  });

  it('routes Workbench icons through one Cutout icon family', () => {
    const webPackage = readFileSync(join(root, 'apps/web/package.json'), 'utf8');
    expect(webPackage).not.toContain('lucide-react');

    for (const path of globSync('apps/web/src/**/*.{ts,tsx}', { cwd: root }).map(portablePath)) {
      const source = readFileSync(join(root, path), 'utf8');
      expect(source, path).not.toContain('lucide-react');
      if (!path.endsWith('/ui/WorkbenchIconProvider.tsx')) {
        expect(source, path).not.toMatch(/from ['"][^'"]*ui\/icons(?:\.js)?['"]/);
      }
    }
  });

  it('reserves display type for sparse text at 15px or larger', () => {
    const panels = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/panels.css'), 'utf8');
    const overlays = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/overlays.css'), 'utf8');
    const canvas = readFileSync(join(root, 'apps/web/src/workbench/styles/canvas.css'), 'utf8');
    const cep = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/styles.css'), 'utf8');
    expect(panels.match(/\.db-panel__title\s*\{[\s\S]*?\}/)?.[0]).not.toContain('--db-font-display');
    expect(overlays.match(/\.db-empty-state strong\s*\{[\s\S]*?\}/)?.[0])
      .toContain('font-size: var(--db-font-lg)');
    expect(canvas.match(/\.canvas-empty-state strong\s*\{[\s\S]*?\}/)?.[0])
      .toContain('font-size: var(--db-font-lg)');
    expect(cep.match(/\.bridge-section__title\s*\{[\s\S]*?\}/)?.[0]).not.toContain('Smiley Sans');
  });

  it('uses solid blocks and hard underlayers instead of decorative line borders', () => {
    const tokens = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/tokens.css'), 'utf8');
    const controls = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/controls.css'), 'utf8');
    const fields = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/fields.css'), 'utf8');
    const menus = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/menus.css'), 'utf8');
    const canvas = readFileSync(join(root, 'apps/web/src/workbench/styles/canvas.css'), 'utf8');
    const buttonRule = controls.match(/\.db-button,\s*\.db-icon-button\s*\{[\s\S]*?\}/)?.[0];
    const fieldRule = fields.match(/\.db-input,\s*\.db-select,\s*\.db-textarea\s*\{[\s\S]*?\}/)?.[0];
    expect(buttonRule).toContain('border: 0');
    expect(buttonRule).toContain('box-shadow: var(--db-shadow-control)');
    expect(fieldRule).toContain('border: 0');
    expect(fieldRule).toContain('box-shadow: var(--db-shadow-control)');
    expect(controls.match(/\.db-tab--strip\.db-tab--active\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-selection)');
    expect(menus.match(/\.db-menu__separator\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: transparent');
    expect(canvas.match(/\.canvas-feedback-add-comment\s*\{[\s\S]*?\}/)?.[0])
      .toContain('border: 0');

    for (const path of globSync('apps/web/src/workbench/**/*.css', { cwd: root }).map(portablePath)) {
      if (path.endsWith('/ui/styles/base.css') || path.endsWith('/styles/canvas.css')) {
        continue;
      }
      const css = readFileSync(join(root, path), 'utf8');
      const visibleBorders = [...css.matchAll(
        /^\s*border(?:-(?:top|right|bottom|left))?\s*:\s*([^;]+);/gm
      )].map((match) => match[1]!.trim()).filter((value) => value !== '0');
      expect(visibleBorders, path).toEqual([]);
    }

    for (const theme of ['light', 'dark'] as const) {
      const underlayer = readThemeHex(tokens, theme, '--db-border');
      const defaultFill = readThemeHex(tokens, theme, '--db-surface-2');
      const surroundingSurface = readThemeHex(tokens, theme, '--db-surface-1');
      expect(contrastRatio(underlayer, defaultFill), `${theme} control underlayer`).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(underlayer, surroundingSurface), `${theme} exposed underlayer`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the Canvas field and affordances on the warm brand palette', () => {
    const tokens = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/tokens.css'), 'utf8');
    const canvas = readFileSync(join(root, 'apps/web/src/workbench/styles/canvas.css'), 'utf8');
    const feedbackBar = readFileSync(
      join(root, 'apps/web/src/workbench/canvas/CanvasFeedbackBar.tsx'),
      'utf8'
    );
    const controls = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/controls.css'), 'utf8');
    const titleBar = readFileSync(join(root, 'apps/web/src/workbench/styles/titlebar.css'), 'utf8');
    const shell = readFileSync(join(root, 'apps/web/src/workbench/styles/shell.css'), 'utf8');

    expect(readThemeHex(tokens, 'light', '--db-canvas-bg')).toBe('#efd8c5');
    expect(readThemeHex(tokens, 'dark', '--db-canvas-bg')).toBe('#1a1815');
    for (const theme of ['light', 'dark'] as const) {
      const canvasBackground = readThemeHex(tokens, theme, '--db-canvas-bg');
      const canvasSelection = readThemeHex(tokens, theme, '--db-canvas-selection');
      const canvasEdge = readThemeHex(tokens, theme, '--db-canvas-edge');
      const feedbackSurface = readThemeHex(tokens, theme, '--db-canvas-feedback-surface');
      const feedbackInk = readThemeHex(tokens, theme, '--db-canvas-feedback-ink');
      const titleBarText = readThemeHex(tokens, theme, '--db-text-muted');
      expect(contrastRatio(canvasSelection, canvasBackground), `${theme} Canvas selection`)
        .toBeGreaterThanOrEqual(3);
      expect(contrastRatio(canvasEdge, canvasBackground), `${theme} Canvas edge`)
        .toBeGreaterThanOrEqual(3);
      expect(contrastRatio(feedbackInk, feedbackSurface), `${theme} Canvas feedback`)
        .toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(titleBarText, canvasBackground), `${theme} title bar text`)
        .toBeGreaterThanOrEqual(4.5);
      for (let index = 1; index <= 6; index += 1) {
        expect(readThemeHex(tokens, theme, `--db-canvas-moment-${index}`)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }

    expect(canvas).toContain('var(--db-canvas-selection)');
    expect(canvas).toContain('var(--db-canvas-feedback-surface)');
    expect(canvas.match(/\.canvas-surface\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-canvas-field)');
    expect(shell.match(/\.workbench-shell\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-canvas-field)');
    expect(titleBar).not.toContain('.workbench-titlebar::before');
    expect(controls).toContain('.db-icon-button--titlebar .db-icon-button__icon,');
    expect(controls.match(/\.db-icon-button--window-close \.db-icon-button__icon\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-canvas-bg)');
    expect(titleBar.match(/\.workbench-titlebar\s*\{[\s\S]*?\}/)?.[0])
      .not.toMatch(/background|border-bottom/);
    expect(feedbackBar.match(/var\(--db-canvas-moment-[1-6]\)/g)).toHaveLength(6);
  });

  it('keeps the Terminal emulator field synchronized with its warm chrome', () => {
    const tokens = readFileSync(join(root, 'apps/web/src/workbench/ui/styles/tokens.css'), 'utf8');
    const terminalStyles = readFileSync(
      join(root, 'apps/web/src/workbench/styles/terminal.css'),
      'utf8'
    );
    const terminalTheme = readFileSync(
      join(root, 'apps/web/src/workbench/terminal/terminalTheme.ts'),
      'utf8'
    );
    for (const theme of ['light', 'dark'] as const) {
      const background = readThemeHex(tokens, theme, '--db-terminal-bg');
      expect(terminalTheme, `${theme} Terminal background`)
        .toContain(`background: '${background}'`);
    }
    expect(tokens).toContain('--db-terminal-tab-bar-bg: var(--db-surface-1)');
    expect(terminalStyles.match(/\.db-terminal-tabs\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-terminal-tab-bar-bg)');
    expect(terminalStyles.match(/\.db-terminal-tab\.db-tab--strip\.db-tab--active\s*\{[\s\S]*?\}/)?.[0])
      .toContain('background: var(--db-terminal-bg)');
  });

  it('keeps owned surfaces flat while reserving gradients for functional guides', () => {
    const stylePaths = [
      ...globSync('apps/web/src/**/*.css', { cwd: root }).map(portablePath),
      'apps/photoshop-cep-plugin/src/styles.css',
      'apps/photoshop-uxp-plugin/src/styles.css'
    ];
    const allowedGradientFiles = new Set([
      'apps/web/src/workbench/ui/styles/tokens.css',
      'apps/web/src/workbench/styles/canvas.css',
      'apps/web/src/workbench/styles/explorer.css'
    ]);
    for (const path of stylePaths) {
      const css = readFileSync(join(root, path), 'utf8');
      expect(css, path).not.toMatch(/backdrop-filter|radial-gradient|filter:\s*drop-shadow|--db-accent/);
      if (/(?:repeating-)?linear-gradient/.test(css)) {
        expect(allowedGradientFiles.has(path), path).toBe(true);
      }
    }

    const intrinsicCircles = stylePaths.flatMap((path) => {
      const css = readFileSync(join(root, path), 'utf8');
      return [...css.matchAll(/([^{}]+)\{[^{}]*border-radius:\s*999px/g)]
        .map((match) => match[1]!.trim());
    }).sort();
    expect(intrinsicCircles).toEqual([
      '.canvas-feedback-comment-pill-badge',
      '.canvas-media-feedback-label',
      '.canvas-node-resize',
      '.db-button__spinner',
      '.db-switch__track'
    ]);
  });

  it('uses bundled fonts in CEP and the Photoshop host font in UXP', () => {
    const cep = readFileSync(join(root, 'apps/photoshop-cep-plugin/src/styles.css'), 'utf8');
    const uxp = readFileSync(join(root, 'apps/photoshop-uxp-plugin/src/styles.css'), 'utf8');
    const uxpBuild = readFileSync(join(root, 'apps/photoshop-uxp-plugin/vite.config.ts'), 'utf8');
    expect(cep).toContain('@font-face');
    expect(cep).toContain('"Noto Sans SC"');
    expect(cep).toContain('"Noto Sans Mono CJK SC"');
    expect(cep).toContain('NotoSansSC-Semibold.woff2');
    expect(cep).toContain('NotoSansMonoCJKsc-Bold.woff2');
    expect(uxp).not.toContain('@font-face');
    expect(uxp).toContain('font-family: inherit');
    expect(uxpBuild).toContain("external: ['uxp']");
  });
});

function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function readThemeHex(css: string, theme: 'light' | 'dark', token: string): string {
  const themePattern = theme === 'light'
    ? /:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/
    : /:root,\s*:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/;
  const declarations = css.match(themePattern)?.[1];
  if (!declarations) throw new Error(`Missing ${theme} theme declarations`);
  const escapedToken = escapeRegExp(token);
  const value = declarations.match(new RegExp(`${escapedToken}:\\s*(#[0-9a-f]{6});`, 'i'))?.[1];
  if (!value) throw new Error(`Missing ${theme} ${token} hex value`);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16) / 255);
  if (!channels || channels.length !== 3) throw new Error(`Invalid color: ${hex}`);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}
