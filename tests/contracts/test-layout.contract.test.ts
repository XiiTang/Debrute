import { describe, expect, it } from 'vitest';
import { validateTestLayout, type TestLayoutProject } from '../../scripts/check-test-layout.js';

const unitProject: TestLayoutProject = {
  configPath: 'apps/example/vitest.config.ts',
  name: 'unit-example',
  root: 'apps/example',
  include: ['src/**/*.test.ts'],
  exclude: []
};

describe('test layout contract', () => {
  it('reports a test owned by zero projects', () => {
    expect(validateTestLayout({
      configPaths: [unitProject.configPath],
      projects: [unitProject],
      files: [{ path: 'apps/other/src/orphan.test.ts', source: '' }]
    })).toEqual([
      'apps/other/src/orphan.test.ts: expected exactly one Vitest project, matched 0'
    ]);
  });

  it('reports a test owned by two projects', () => {
    const duplicateOwner = { ...unitProject, configPath: 'apps/example/vitest.node.config.ts', name: 'unit-example-node' };
    expect(validateTestLayout({
      configPaths: [unitProject.configPath, duplicateOwner.configPath],
      projects: [unitProject, duplicateOwner],
      files: [{ path: 'apps/example/src/owned.test.ts', source: '' }]
    })).toEqual([
      'apps/example/src/owned.test.ts: expected exactly one Vitest project, matched 2 (unit-example, unit-example-node)'
    ]);
  });

  it('rejects top-level tests files', () => {
    const contracts = project('contracts', 'tests/contracts/**/*.contract.test.ts');
    expect(validateTestLayout({
      configPaths: [contracts.configPath],
      projects: [contracts],
      files: [{ path: 'tests/foo.test.ts', source: '' }]
    })).toContain('tests/foo.test.ts: test files must not live directly under tests/');
  });

  it('rejects directory and suffix mismatches', () => {
    const broadContracts = project('contracts', 'tests/contracts/**/*.test.ts');
    expect(validateTestLayout({
      configPaths: [broadContracts.configPath],
      projects: [broadContracts],
      files: [{ path: 'tests/contracts/wrong.release.test.ts', source: '' }]
    })).toContain('tests/contracts/wrong.release.test.ts: tests/contracts requires the .contract.test.ts suffix');
  });

  it('rejects file-level Vitest environment directives', () => {
    expect(syntaxViolations('// @vitest-environment jsdom\n')).toEqual([
      'apps/example/src/example.test.ts: file-level Vitest environment directives are not allowed'
    ]);
  });

  it.each([
    ['describe.skip', "describe.skip('suite', () => {});", 'describe.skip'],
    ['it.todo', "it.todo('case');", 'it.todo'],
    ['test.skip', "test.skip('case', () => {});", 'test.skip'],
    ['xit', "xit('case', () => {});", 'xit'],
    ['xtest', "xtest('case', () => {});", 'xtest'],
    ['xdescribe', "xdescribe('suite', () => {});", 'xdescribe'],
    ['suite.skip', "suite.skip('suite', () => {});", 'suite.skip'],
    ['describe.todo', "describe.todo('suite');", 'describe.todo'],
    ['it.skipIf', "it.skipIf(true)('case', () => {});", 'it.skipIf'],
    ['test.skipIf', "test.skipIf(true)('case', () => {});", 'test.skipIf'],
    ['describe.runIf.each', "describe.runIf(false).each([1])('suite', () => {});", 'describe.runIf'],
    ['describe.each(...).runIf', "describe.each([1]).runIf(false)('suite', () => {});", 'describe.runIf'],
    ['suite.runIf.each', "suite.runIf(false).each([1])('suite', () => {});", 'suite.runIf'],
    ['suite.each(...).runIf', "suite.each([1]).runIf(false)('suite', () => {});", 'suite.runIf'],
    ['it.runIf.each', "it.runIf(false).each([1])('case', () => {});", 'it.runIf'],
    ['it.each(...).runIf', "it.each([1]).runIf(false)('case', () => {});", 'it.runIf'],
    ['test.runIf.each', "test.runIf(false).each([1])('case', () => {});", 'test.runIf'],
    ['test.each(...).runIf', "test.each([1]).runIf(false)('case', () => {});", 'test.runIf'],
    ['describe.each(...).skip', "describe.each([1]).skip('suite', () => {});", 'describe.skip'],
    ['describe.skip.each', "describe.skip.each([1])('suite', () => {});", 'describe.skip'],
    ['it.skip.each', "it.skip.each([1])('case', () => {});", 'it.skip'],
    ['test.todo.each', "test.todo.each([1])('case');", 'test.todo'],
    ['retry', "it('case', { retry: 1 }, () => {});", 'retry:']
  ])('rejects committed %s syntax', (_label, source, syntax) => {
    expect(syntaxViolations(source)).toEqual([
      `apps/example/src/example.test.ts: committed ${syntax} syntax is not allowed`
    ]);
  });

  it('rejects shorthand retry in Vitest test options', () => {
    expect(syntaxViolations("const retry = 1; it('case', { retry }, () => {});"))
      .toEqual(['apps/example/src/example.test.ts: committed retry: syntax is not allowed']);
  });

  it.each([
    ["suite('suite', { retry: 1 }, () => {});"],
    ["const retry = 1; suite('suite', { retry }, () => {});"]
  ])('rejects retry in suite options', (source) => {
    expect(syntaxViolations(source))
      .toEqual(['apps/example/src/example.test.ts: committed retry: syntax is not allowed']);
  });

  it('does not reject ordinary business chains or retry properties', () => {
    expect(syntaxViolations([
      'const request = { retry: () => undefined };',
      'caseIt.skip.each();',
      'client.todo();',
      'client.runIf(false);'
    ].join('\n'))).toEqual([]);
  });

  it('reports duplicate project names once', () => {
    const duplicateName = { ...unitProject, configPath: 'apps/other/vitest.config.ts', root: 'apps/other' };
    expect(validateTestLayout({
      configPaths: [unitProject.configPath, duplicateName.configPath],
      projects: [unitProject, duplicateName],
      files: []
    })).toEqual(['Vitest project name "unit-example" is declared more than once']);
  });

  it('reports duplicate discovered config paths once', () => {
    expect(validateTestLayout({
      configPaths: [unitProject.configPath, unitProject.configPath],
      projects: [unitProject],
      files: []
    })).toEqual(['Vitest config "apps/example/vitest.config.ts" was discovered more than once']);
  });

  it('does not require project ownership for test support modules', () => {
    expect(validateTestLayout({
      configPaths: [],
      projects: [],
      files: [{ path: 'tests/helpers/support.ts', source: '' }]
    })).toEqual([]);
  });

  it('normalizes Windows path separators before ownership checks', () => {
    expect(validateTestLayout({
      configPaths: [unitProject.configPath],
      projects: [unitProject],
      files: [{ path: 'apps\\example\\src\\owned.test.ts', source: '' }]
    })).toEqual([]);
  });
});

function project(name: string, include: string): TestLayoutProject {
  return {
    configPath: `tests/config/vitest.${name}.ts`,
    name,
    root: '',
    include: [include],
    exclude: []
  };
}

function syntaxViolations(source: string): string[] {
  return validateTestLayout({
    configPaths: [unitProject.configPath],
    projects: [unitProject],
    files: [{ path: 'apps/example/src/example.test.ts', source }]
  });
}
