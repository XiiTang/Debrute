import { globSync, readFileSync } from 'node:fs';
import { matchesGlob, resolve } from 'node:path';
import { dirname, relative } from 'node:path/posix';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

export interface TestLayoutProject {
  configPath: string;
  name: string;
  root: string;
  include: string[];
  exclude: string[];
}

export interface TestLayoutFile {
  path: string;
  source: string;
}

export function validateTestLayout(input: {
  configPaths: string[];
  projects: TestLayoutProject[];
  files: TestLayoutFile[];
}): string[] {
  const violations = new Set<string>();

  for (const configPath of duplicates(input.configPaths.map(normalizedPath))) {
    violations.add(`Vitest config "${configPath}" was discovered more than once`);
  }
  for (const name of duplicates(input.projects.map((project) => project.name))) {
    violations.add(`Vitest project name "${name}" is declared more than once`);
  }

  for (const file of input.files) {
    const path = normalizedPath(file.path);
    if (isTestFile(path)) {
      const owners = input.projects
        .filter((project) => projectOwnsFile(project, path))
        .map((project) => project.name)
        .sort();
      if (owners.length !== 1) {
        const ownerList = owners.length > 0 ? ` (${owners.join(', ')})` : '';
        violations.add(`${path}: expected exactly one Vitest project, matched ${owners.length}${ownerList}`);
      }
      for (const violation of testPathViolations(path)) {
        violations.add(violation);
      }
    }
    for (const violation of sourceViolations(path, file.source)) {
      violations.add(violation);
    }
  }

  return [...violations];
}

export async function checkTestLayout(root = process.cwd()): Promise<string[]> {
  const { discoverTestProjectConfigs } = await import('../vitest.config.js');
  const configPaths = discoverTestProjectConfigs(root).map(normalizedPath);
  const projects = await Promise.all(configPaths.map((configPath) => loadProject(root, configPath)));
  const testPaths = testSourcePaths(root);
  const inspectedPaths = [...new Set([
    ...testPaths,
    ...configPaths,
    'vitest.config.ts',
    ...globSync('tests/config/**/*.ts', { cwd: root }).map(normalizedPath)
  ])].sort();
  const files = inspectedPaths.map((path) => ({
    path,
    source: readFileSync(resolve(root, path), 'utf8')
  }));
  return validateTestLayout({ configPaths, projects, files });
}

function projectOwnsFile(project: TestLayoutProject, filePath: string): boolean {
  const root = normalizedPath(project.root).replace(/\/$/, '');
  const projectPath = relative(root || '.', filePath);
  return project.include.some((pattern) => matchesGlob(projectPath, normalizedPath(pattern)))
    && !project.exclude.some((pattern) => matchesGlob(projectPath, normalizedPath(pattern)));
}

function testPathViolations(path: string): string[] {
  if (/^tests\/[^/]+\.test\.tsx?$/.test(path)) {
    return [`${path}: test files must not live directly under tests/`];
  }
  const rules = [
    { directory: 'tests/contracts/', suffix: '.contract.test.ts', allowTsx: false },
    { directory: 'tests/release/', suffix: '.release.test.ts', allowTsx: false }
  ];
  const rule = rules.find((candidate) => path.startsWith(candidate.directory));
  if (rule) {
    const valid = path.endsWith(rule.suffix) || (rule.allowTsx && path.endsWith(`${rule.suffix}x`));
    return valid ? [] : [`${path}: ${rule.directory.slice(0, -1)} requires the ${rule.suffix} suffix`];
  }
  if (path.startsWith('tests/')) {
    return [`${path}: tests/ test files must live under contracts or release`];
  }

  const reservedSuffix = [
    '.contract.test.ts',
    '.release.test.ts'
  ].find((suffix) => path.endsWith(suffix) || path.endsWith(`${suffix}x`));
  if (reservedSuffix) {
    return [`${path}: ${reservedSuffix} is reserved for its tests/ execution-class directory`];
  }
  if ((path.endsWith('.dom.test.ts') || path.endsWith('.dom.test.tsx')) && !path.startsWith('apps/web/')) {
    return [`${path}: the .dom.test suffix is reserved for apps/web`];
  }
  return [];
}

function sourceViolations(path: string, source: string): string[] {
  const violations = new Set<string>();
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      && scanner.getTokenText().includes('@vitest-environment')
    ) {
      violations.add(`${path}: file-level Vitest environment directives are not allowed`);
    }
  }

  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  visit(sourceFile);
  return [...violations];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const syntax = skippedVitestSyntax(node.expression);
      if (syntax) {
        violations.add(`${path}: committed ${syntax} syntax is not allowed`);
      }
    }
    if (
      isRetryProperty(node)
      && isVitestRetryProperty(node, path)
    ) {
      violations.add(`${path}: committed retry: syntax is not allowed`);
    }
    ts.forEachChild(node, visit);
  }
}

type RetryProperty = ts.PropertyAssignment | ts.ShorthandPropertyAssignment;

function isRetryProperty(node: ts.Node): node is RetryProperty {
  return (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
    && propertyName(node.name) === 'retry';
}

function isVitestRetryProperty(node: RetryProperty, path: string): boolean {
  if (
    path === 'vitest.config.ts'
    || path.startsWith('tests/config/')
    || /\/vitest(?:\.[^.]+)?\.config\.ts$/.test(path)
  ) {
    return true;
  }
  const object = node.parent;
  const call = object.parent;
  return ts.isObjectLiteralExpression(object)
    && ts.isCallExpression(call)
    && call.arguments.includes(object)
    && ['describe', 'suite', 'it', 'test'].includes(callRootName(call.expression) ?? '');
}

function skippedVitestSyntax(expression: ts.LeftHandSideExpression): string | undefined {
  const chain = vitestCallChain(expression);
  if (!chain) {
    return undefined;
  }
  if (chain.root === 'xit' || chain.root === 'xtest' || chain.root === 'xdescribe') {
    return chain.root;
  }
  if (!['describe', 'suite', 'it', 'test'].includes(chain.root)) {
    return undefined;
  }
  const modifier = chain.modifiers.find(
    (value) => value === 'skip' || value === 'todo' || value === 'skipIf' || value === 'runIf'
  );
  if (!modifier) {
    return undefined;
  }
  return `${chain.root}.${modifier}`;
}

function callRootName(expression: ts.Expression): string | undefined {
  return vitestCallChain(expression)?.root;
}

function vitestCallChain(expression: ts.Expression): { root: string; modifiers: string[] } | undefined {
  if (ts.isIdentifier(expression)) {
    return { root: expression.text, modifiers: [] };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const chain = vitestCallChain(expression.expression);
    return chain ? { ...chain, modifiers: [...chain.modifiers, expression.name.text] } : undefined;
  }
  if (ts.isCallExpression(expression)) {
    return vitestCallChain(expression.expression);
  }
  return undefined;
}

function propertyName(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

async function loadProject(root: string, configPath: string): Promise<TestLayoutProject> {
  const absoluteConfigPath = resolve(root, configPath);
  const loaded = await import(pathToFileURL(absoluteConfigPath).href) as {
    default: { test?: { name?: unknown; include?: unknown; exclude?: unknown } };
  };
  const metadata = loaded.default.test;
  if (
    !metadata
    || typeof metadata.name !== 'string'
    || !Array.isArray(metadata.include)
    || !metadata.include.every((pattern) => typeof pattern === 'string')
    || (metadata.exclude !== undefined && (
      !Array.isArray(metadata.exclude)
      || !metadata.exclude.every((pattern) => typeof pattern === 'string')
    ))
  ) {
    throw new Error(`${configPath}: expected Vitest name/include/exclude metadata`);
  }
  return {
    configPath,
    name: metadata.name,
    root: normalizedPath(dirname(configPath)),
    include: metadata.include,
    exclude: metadata.exclude ?? []
  };
}

function testSourcePaths(root: string): string[] {
  const options = {
    cwd: root,
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-electron/**', '**/build/**']
  };
  return [...new Set([
    ...globSync('apps/**/*.test.ts', options),
    ...globSync('apps/**/*.test.tsx', options),
    ...globSync('packages/**/*.test.ts', options),
    ...globSync('packages/**/*.test.tsx', options),
    ...globSync('tests/**/*.test.ts', options),
    ...globSync('tests/**/*.test.tsx', options)
  ].map(normalizedPath))].sort();
}

function isTestFile(path: string): boolean {
  return /\.test\.tsx?$/.test(path);
}

function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const violations = await checkTestLayout(process.cwd());
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(violation);
    }
    process.exitCode = 1;
  } else {
    console.log('Test layout passed.');
  }
}
