import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const allowedStringPatterns = [
  /^$/,
  /^[a-z0-9_.:/#?&=%-]+$/i,
  /^db-/,
  /^canvas-/,
  /^workbench-/,
  /^project-/,
  /^terminal-/,
  /^inspector-/,
  /^settings-/,
  /^aria-/,
  /^data-/,
  /^\[/,
  /^button:not/,
  /^\[role=/,
  /^@/,
  /^http/,
  /^var\(/,
  /^[0-9a-z().,\s-]+var\(--[a-z0-9-]+\)$/i,
  /^[a-z0-9_-]+(?:\s+[a-z0-9_-]+)+$/i,
  /^[A-Za-z0-9_\-(),"\s]+,\s*(monospace|sans-serif)$/,
  /^\{value\}/,
  /^\$\{[a-zA-Z0-9_]+\}$/,
  /^\/projects\/\{value\}$/,
  /^\/api\/projects\/\{value\}\//,
  /^sha256:\{value\}$/,
  /^debrute:/,
  /^floating-panel/,
  /^translate[XY]?\(/,
  /^M \{value\} \{value\}$/,
  /^L \{value\} \{value\}$/,
  /^0 0 \{value\} \{value\}$/,
  /^Debrute/,
  /^Photoshop$/,
  /^Homebrew$/,
  /^winget$/,
  /^APT$/,
  /^uv$/,
  /^pipx$/,
  /^OpenAI/,
  /^Anthropic/,
  /^\.[a-z0-9]/,
  /^[A-Z0-9_]+$/,
  /^Clipboard unavailable$/,
  /^Upload import path /,
  /^Cannot apply Canvas document \{value\} without /,
  /^Canvas perf debug snapshot context is unavailable\.$/,
  /^Canvas text preview /,
  /^Canvas image /,
  /^Canvas preview/,
  /^Canvas camera /,
  /^Canvas gesture /,
  /^Unable to load \{value\}\.$/,
  /^exit \{value\}$/,
  /^Resize node \{value\}$/,
  /^Resize \{value\}$/,
  /^CanvasImageNodeAssetProvider is required\.$/,
  /^Workbench locale must be "en" or "zh-CN"\.$/,
  /^Workbench viewport requires a browser window\.$/,
  /^Electron shell IPC is unavailable\.$/,
  /^Electron external drop did not expose every dropped file path\.$/,
  /^Browser external drop did not expose every dropped file entry\.$/,
  /^Recent project command requires projectRoot\.$/,
  /^useI18n must be used inside I18nProvider\.$/,
  /^Name (is required|must not contain path separators)\.$/,
  /^Project path /,
  /^,\s*[a-zA-Z]+:\s*$/,
  /^\)\)\.join\($/,
  /^\) return $/,
  /^ \|\| result\.status === $/,
  /^\).replace/,
  /^\s+\? value : $/,
  /^,\s*message: i18n\.t\($/,
  /^\s+[a-z0-9_-]+$/,
  /^,\s+\.\.\.rest\.map/,
  /^\)\.filter\(Boolean\)\.join\($/,
  /^\) \|\| name\.includes\($/,
  /^\s+:\s+parts\.slice/,
  /^\) \? 1 : handle\.includes\($/,
  /^\)\.at\(-1\)\?\.replaceAll\($/,
  /^[{}()[\],.:;'"`|+\-*/\\\s]+$/
];

const excludedFiles = [
  'apps/web/src/workbench/i18n/dictionaries.ts',
  'apps/web/src/workbench/i18n/i18n.test.tsx'
];

describe('Workbench i18n source contract', () => {
  it('keeps Workbench product copy in dictionaries', () => {
    const files = walkWorkbenchSources(join(process.cwd(), 'apps/web/src/workbench'))
      .map((file) => relative(process.cwd(), file))
      .filter((file) => (
        !file.endsWith('.test.ts')
        && !file.endsWith('.test.tsx')
        && !excludedFiles.includes(file)
      ));

    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return extractSourceStrings(source)
        .map((text) => ({ file, text }))
        .filter(({ text }) => /[A-Za-z][a-z]+/.test(text))
        .filter(({ text }) => !allowedStringPatterns.some((pattern) => pattern.test(text)))
        .map(({ file, text }) => `${file}: ${text}`);
    });

    expect(violations).toEqual([]);
  });
});

function extractSourceStrings(source: string): string[] {
  return [
    ...[...source.matchAll(/(['"])((?:\\.|(?!\1)[^\\\n]){3,})\1/g)].map((match) => match[2]!),
    ...[...source.matchAll(/`((?:\\.|[^`\\\n]){3,})`/g)].flatMap((match) => templateTextSegments(match[1]!))
  ];
}

function templateTextSegments(template: string): string[] {
  const text = template.replace(/\$\{[^}]*\}/g, '{value}').trim();
  return text.length >= 3 ? [text] : [];
}

function walkWorkbenchSources(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const absolute = join(root, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      return walkWorkbenchSources(absolute);
    }
    return absolute.endsWith('.ts') || absolute.endsWith('.tsx') ? [absolute] : [];
  });
}
