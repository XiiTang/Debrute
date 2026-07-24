import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dirname, normalize } from 'node:path/posix';

export const architectureScopes = [
  'packages',
  'apps/desktop/package.json',
  'apps/desktop/tsconfig.json',
  'apps/desktop/src',
  'apps/web/src',
  'apps/web/vite.config.ts',
  'apps/web/package.json',
  'apps/web/tsconfig.json',
  'scripts',
  'tests'
];

export const importMatrix = [
  {
    name: 'packages do not import apps',
    match: (file) => file.startsWith('packages/') && !file.startsWith('packages/architecture-rules/'),
    forbiddenImports: [/^apps\//, /^\.\.\/\.\.\/apps\//]
  },
  {
    name: 'app-protocol stays free of orchestration and runtime execution',
    match: (file) => file.startsWith('packages/app-protocol/src/'),
    forbiddenImports: [/^electron$/, /^react$/, /^node:/]
  },
  {
    name: 'canvas-core does not depend on renderer applications',
    match: (file) => file.startsWith('packages/canvas-core/src/'),
    forbiddenImports: [/^@debrute\/app-protocol$/, /apps\/desktop/, /apps\/web/, /^electron$/, /^react$/]
  },
  {
    name: 'runtime-control-client stays a native transport adapter',
    match: (file) => file.startsWith('packages/runtime-control-client/src/'),
    forbiddenImports: [/^electron$/, /^react$/]
  },
  {
    name: 'web workbench does not import electron',
    match: (file) => file.startsWith('apps/web/src/'),
    forbiddenImports: [/^electron$/]
  },
  {
    name: 'web features use the owned Workbench UI surface',
    match: (file) => file.startsWith('apps/web/src/workbench/')
      && !file.startsWith('apps/web/src/workbench/ui/')
      && !isTestSourceFile(file),
    forbiddenImports: [
      /^@radix-ui(?:\/|$)/,
      /^antd(?:\/|$)/,
      /^@mui(?:\/|$)/,
      /^@chakra-ui(?:\/|$)/,
      /^@mantine(?:\/|$)/,
      /^@fluentui(?:\/|$)/,
      /^bootstrap(?:\/|$)/,
      /^react-bootstrap(?:\/|$)/
    ]
  },
  {
    name: 'web workbench runtime does not import node filesystem',
    match: (file) => file.startsWith('apps/web/src/') && !isTestSourceFile(file),
    forbiddenImports: [/^node:fs$/, /^node:fs\/promises$/, /^fs$/, /^fs\/promises$/]
  },
  {
    name: 'desktop electron stays a native host and client',
    match: (file) => file.startsWith('apps/desktop/src/electron/'),
    forbiddenImports: [
      /^@debrute\/canvas-core(?:\/|$)/,
      /^@debrute\/web(?:\/|$)/,
      /^apps\/web\//,
      /^packages\/canvas-core\/src\//,
      /^\.\.\/\.\.\/\.\.\/web\//,
      /^react(?:\/|$)/,
      /^react-dom(?:\/|$)/
    ]
  }
];

export function architectureRuleKinds() {
  return ['imports', 'package-json', 'tsconfig', 'vite-alias'];
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

function isTestSourceFile(file) {
  return /\.test\.[cm]?[jt]sx?$/.test(file);
}

export async function architectureBoundaryViolations(root = process.cwd(), files = rgFiles(root)) {
  const contents = await Promise.all(files
    .filter(isScannableArchitectureFile)
    .map(async (file) => [file, await readFile(join(root, file), 'utf8')]));

  return [
    ...contents.flatMap(([file, text]) => importViolations(file, text)),
    ...contents.flatMap(([file, text]) => packageJsonViolations(file, text)),
    ...contents.flatMap(([file, text]) => tsconfigViolations(file, text)),
    ...contents.flatMap(([file, text]) => viteAliasViolations(file, text))
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

function packageJsonViolations(file, text) {
  if (file === 'apps/desktop/package.json') {
    const pkg = JSON.parse(text);
    return allowedPackageDependencyViolations(file, pkg, 'desktop electron stays a native host and client', {
      dependencies: new Set([
        '@debrute/app-protocol',
        '@debrute/runtime-control-client'
      ]),
      devDependencies: new Set(['electron', 'electron-builder', 'esbuild', 'typescript']),
      optionalDependencies: new Set(),
      peerDependencies: new Set()
    });
  }
  if (file === 'apps/web/package.json') {
    const pkg = JSON.parse(text);
    const disallowed = new Set([
      'tailwindcss',
      'shadcn',
      'shadcn-ui',
      'antd',
      '@mui/material',
      '@chakra-ui/react',
      '@mantine/core',
      '@fluentui/react-components',
      'bootstrap',
      'react-bootstrap'
    ]);
    return packageDependencySections.flatMap((sectionName) => Object.keys(pkg[sectionName] ?? {})
      .filter((dependency) => disallowed.has(dependency))
      .map((dependency) => `web package uses the owned Workbench UI surface: ${file} declares ${dependency} in ${sectionName}`));
  }
  return [];
}

function tsconfigViolations(file, text) {
  if (file === 'apps/desktop/tsconfig.json') {
    const config = JSON.parse(text);
    const references = (config.references ?? []).map((reference) => reference.path);
    return [
      '../../packages/canvas-core',
      '../../apps/web'
    ]
      .filter((reference) => references.includes(reference))
      .map((reference) => `desktop electron stays a native host and client: ${file} references ${reference}`);
  }
  return [];
}

const packageDependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

function allowedPackageDependencyViolations(file, pkg, ruleName, allowedDependenciesBySection) {
  return packageDependencySections.flatMap((sectionName) => {
    const allowedDependencies = allowedDependenciesBySection[sectionName] ?? new Set();
    return Object.keys(pkg[sectionName] ?? {})
      .filter((dependency) => !allowedDependencies.has(dependency))
      .map((dependency) => `${ruleName}: ${file} declares ${dependency} in ${sectionName}`);
  });
}

function viteAliasViolations(file, text) {
  if (file !== 'apps/web/vite.config.ts') {
    return [];
  }
  const aliases = [...text.matchAll(/['"](@debrute\/[^'"]+)['"]\s*:/g)].map((match) => match[1]);
  const allowedAliases = new Set([
    '@debrute/app-protocol',
    '@debrute/canvas-core'
  ]);
  return aliases
    .filter((alias) => !allowedAliases.has(alias))
    .map((alias) => `web workbench Vite aliases stay renderer-safe: ${file} aliases ${alias}`);
}
