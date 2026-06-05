import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname, normalize } from 'node:path/posix';

export const architectureScopes = [
  'packages',
  'apps/desktop/src',
  'apps/web/src',
  'apps/web/vite.config.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'apps/daemon/src',
  'apps/daemon/package.json',
  'apps/daemon/tsconfig.json',
  'apps/app-server/src',
  'apps/debrute-cli/src',
  'apps/debrute-cli/package.json',
  'apps/debrute-cli/tsconfig.json',
  'scripts',
  'tests'
];

export const importMatrix = [
  {
    name: 'packages do not import apps',
    match: (file) => file.startsWith('packages/') && !file.startsWith('packages/architecture-rules/'),
    forbiddenImports: [/^@debrute\/app-server$/, /^apps\//, /^\.\.\/\.\.\/apps\//]
  },
  {
    name: 'app-protocol stays free of orchestration and runtime execution',
    match: (file) => file.startsWith('packages/app-protocol/src/'),
    forbiddenImports: [/^@debrute\/app-server$/, /^@debrute\/capability-core$/, /^@debrute\/capability-runtime$/, /^electron$/, /^react$/, /^node:/]
  },
  {
    name: 'capability-runtime does not depend on app-server or workbench renderer',
    match: (file) => file.startsWith('packages/capability-runtime/src/'),
    forbiddenImports: [/^@debrute\/app-server$/, /apps\/desktop/, /apps\/web/, /^electron$/, /^react$/]
  },
  {
    name: 'project-core stays independent of app and runtime layers',
    match: (file) => file.startsWith('packages/project-core/src/'),
    forbiddenImports: [/^@debrute\/app-protocol$/, /^@debrute\/capability-runtime$/, /^@debrute\/app-server$/, /apps\//, /^electron$/, /^react$/]
  },
  {
    name: 'flowmap-core stays independent of app and runtime layers',
    match: (file) => file.startsWith('packages/flowmap-core/src/'),
    forbiddenImports: [/^@debrute\/app-protocol$/, /^@debrute\/capability-runtime$/, /^@debrute\/app-server$/, /apps\//, /^electron$/, /^react$/]
  },
  {
    name: 'capability-core stays dependency-light',
    match: (file) => file.startsWith('packages/capability-core/src/'),
    forbiddenImports: [/^@debrute\/app-protocol$/, /^@debrute\/capability-runtime$/, /^@debrute\/app-server$/, /apps\//, /^electron$/, /^react$/]
  },
  {
    name: 'canvas-core does not depend on renderer or app-server',
    match: (file) => file.startsWith('packages/canvas-core/src/'),
    forbiddenImports: [/^@debrute\/app-protocol$/, /^@debrute\/capability-runtime$/, /^@debrute\/app-server$/, /apps\/desktop/, /apps\/web/, /^electron$/, /^react$/]
  },
  {
    name: 'workbench-runtime stays launch-free and app-independent',
    match: (file) => file.startsWith('packages/workbench-runtime/src/'),
    forbiddenImports: [/^@debrute\/daemon$/, /^@debrute\/app-server$/, /^electron$/]
  },
  {
    name: 'web workbench does not import app-server',
    match: (file) => file.startsWith('apps/web/src/'),
    forbiddenImports: [/^@debrute\/app-server$/, /^apps\/app-server\//, /^@debrute\/capability-runtime$/, /^@debrute\/capability-core$/]
  },
  {
    name: 'web workbench does not import electron or node filesystem',
    match: (file) => file.startsWith('apps/web/src/'),
    forbiddenImports: [/^electron$/, /^node:fs$/, /^node:fs\/promises$/, /^fs$/, /^fs\/promises$/]
  },
  {
    name: 'desktop electron does not import web workbench internals',
    match: (file) => file.startsWith('apps/desktop/src/electron/'),
    forbiddenImports: [/apps\/web\/src\/workbench/, /^\.\.\/\.\.\/\.\.\/web\/src\/workbench/, /^react$/, /^react-dom/]
  },
  {
    name: 'app-server does not import UI runtimes or react',
    match: (file) => file.startsWith('apps/app-server/src/'),
    forbiddenImports: [/apps\/desktop/, /apps\/web/, /^@debrute\/desktop$/, /^@debrute\/web$/, /^react$/]
  },
  {
    name: 'cli stays behind app-server and protocol boundaries',
    match: (file) => file.startsWith('apps/debrute-cli/src/'),
    forbiddenImports: [
      /^@debrute\/flowmap-core$/,
      /^@debrute\/project-core$/,
      /^@debrute\/canvas-core$/,
      /^@debrute\/capability-core$/,
      /^packages\/flowmap-core\/src\//,
      /^packages\/project-core\/src\//,
      /^packages\/canvas-core\/src\//,
      /^packages\/capability-core\/src\//
    ]
  }
];

export const exportRules = [
  {
    name: 'app-protocol does not export runtime-owned config entries',
    match: (file) => file === 'packages/app-protocol/src/index.ts',
    forbiddenExportNames: ['ImageModelConfig', 'VideoModelConfig']
  }
];

export const publicBarrelRules = [
  {
    name: 'app-server public barrel stays small',
    file: 'apps/app-server/src/index.ts',
    maxNonEmptyLines: 120,
    allowedExportSources: [
      './server/DebruteAppServer.js',
      './server/DebruteGlobalRuntimeServer.js',
      './config/GlobalConfigStore.js',
      '@debrute/app-protocol',
      '@debrute/canvas-core'
    ]
  }
];

export function architectureRuleKinds() {
  return ['imports', 'exports', 'package-json', 'tsconfig', 'vite-alias', 'public-barrel'];
}

export function rgFiles(root, scopes = architectureScopes) {
  return execFileSync('rg', ['--files', ...scopes], { cwd: root, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

export function isScannableArchitectureFile(file) {
  return !file.endsWith('.md')
    && !file.endsWith('.map')
    && !file.includes('/dist/')
    && !file.includes('/dist-electron/')
    && !file.includes('/node_modules/');
}

export async function architectureBoundaryViolations(root = process.cwd(), files = rgFiles(root)) {
  const contents = await Promise.all(files
    .filter(isScannableArchitectureFile)
    .map(async (file) => [file, await readFile(join(root, file), 'utf8')]));

  return [
    ...contents.flatMap(([file, text]) => importViolations(file, text)),
    ...contents.flatMap(([file, text]) => exportViolations(file, text)),
    ...contents.flatMap(([file, text]) => packageJsonViolations(file, text)),
    ...contents.flatMap(([file, text]) => tsconfigViolations(file, text)),
    ...contents.flatMap(([file, text]) => viteAliasViolations(file, text)),
    ...contents.flatMap(([file, text]) => publicBarrelRules
      .filter((rule) => rule.file === file)
      .flatMap((rule) => barrelViolations(rule, file, text)))
  ];
}

function importViolations(file, text) {
  const specifiers = architectureImportSpecifiers(file, text);
  const reportedSpecifiers = new Set();
  return importMatrix
    .filter((rule) => rule.match(file))
    .flatMap((rule) => specifiers
      .filter((specifier) => !reportedSpecifiers.has(specifier))
      .filter((specifier) => rule.forbiddenImports.some((pattern) => pattern.test(specifier)))
      .map((specifier) => {
        reportedSpecifiers.add(specifier);
        return `${rule.name}: ${file} imports "${specifier}"`;
      }));
}

export function architectureImportSpecifiers(file, text) {
  return importedSpecifiers(text).map((specifier) => resolvedImportSpecifier(file, specifier));
}

export function resolvedImportSpecifier(file, specifier) {
  if (!specifier.startsWith('.')) {
    return specifier;
  }
  const resolved = normalize(`${dirname(file)}/${specifier}`);
  return resolved.startsWith('../') ? specifier : resolved;
}

export function importedSpecifiers(text) {
  const specifiers = [];
  const importExportPattern = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(importExportPattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  for (const match of text.matchAll(dynamicImportPattern)) {
    if (match[1]) {
      specifiers.push(match[1]);
    }
  }
  return specifiers;
}

export function exportedDeclarationNames(text) {
  const names = [];
  const declarationPattern = /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|function|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declarationPattern)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names;
}

function exportViolations(file, text) {
  const exportedNames = new Set(exportedDeclarationNames(text));
  return exportRules
    .filter((rule) => rule.match(file))
    .flatMap((rule) => rule.forbiddenExportNames
      .filter((name) => exportedNames.has(name))
      .map((name) => `${rule.name}: ${file} exports ${name}`));
}

function packageJsonViolations(file, text) {
  if (file !== 'apps/debrute-cli/package.json') {
    return [];
  }
  const pkg = JSON.parse(text);
  const dependencies = new Set(Object.keys(pkg.dependencies ?? {}));
  return ['@debrute/project-core', '@debrute/flowmap-core', '@debrute/canvas-core', '@debrute/capability-core']
    .filter((dependency) => dependencies.has(dependency))
    .map((dependency) => `cli stays behind app-server and protocol boundaries: ${file} depends on ${dependency}`);
}

function tsconfigViolations(file, text) {
  if (file !== 'apps/debrute-cli/tsconfig.json') {
    return [];
  }
  const config = JSON.parse(text);
  const references = (config.references ?? []).map((reference) => reference.path);
  return ['../../packages/project-core', '../../packages/flowmap-core', '../../packages/canvas-core', '../../packages/capability-core']
    .filter((reference) => references.includes(reference))
    .map((reference) => `cli stays behind app-server and protocol boundaries: ${file} references ${reference}`);
}

function viteAliasViolations(file, text) {
  if (file !== 'apps/web/vite.config.ts') {
    return [];
  }
  const aliases = [...text.matchAll(/['"](@debrute\/[^'"]+)['"]\s*:/g)].map((match) => match[1]);
  const allowedAliases = new Set(['@debrute/app-protocol', '@debrute/project-core', '@debrute/canvas-core']);
  return aliases
    .filter((alias) => !allowedAliases.has(alias))
    .map((alias) => `web workbench Vite aliases stay renderer-safe: ${file} aliases ${alias}`);
}

function barrelViolations(rule, file, text) {
  const nonEmptyLines = text.split('\n').filter((line) => line.trim().length > 0);
  const exportSources = importedSpecifiers(text);
  return [
    ...(nonEmptyLines.length > rule.maxNonEmptyLines
      ? [`${rule.name}: ${file} has ${nonEmptyLines.length} non-empty lines, max ${rule.maxNonEmptyLines}`]
      : []),
    ...exportSources
      .filter((source) => !rule.allowedExportSources.includes(source))
      .map((source) => `${rule.name}: ${file} exports from ${source}`)
  ];
}
