import { describe, expect, it } from 'vitest';

import {
  createSlowTestsReport,
  evaluatePerformance,
  resolvePerformanceExitCode,
  shouldEnforceTimingBudgets,
  type PerformanceEvaluationInput,
  type PerformanceFileMeasurement,
  type PerformanceTestMeasurement
} from '../config/performance-reporter.js';
import { resolveWorkerPlan } from '../config/workers.js';

const GIB = 1024 ** 3;

function input(overrides: Partial<PerformanceEvaluationInput> = {}): PerformanceEvaluationInput {
  return {
    workerPlan: resolveWorkerPlan({ availableCpus: 6, totalMemoryBytes: 8 * GIB }),
    enforceTimingBudgets: true,
    runStartMs: 1_000,
    runEndMs: 11_000,
    files: [],
    tests: [],
    ...overrides
  };
}

describe('performance reporter contract', () => {
  it.each([
    [undefined, 1],
    [0, 1],
    ['0', 1],
    [2, 2],
    ['2', '2']
  ])('resolves timing violations from exit code %s', (current, expected) => {
    expect(resolvePerformanceExitCode(current, true)).toBe(expected);
  });

  it.each([undefined, 0, 2, '2'])('leaves exit code %s unchanged without timing violations', (current) => {
    expect(resolvePerformanceExitCode(current, false)).toBe(current);
  });

  it('enforces total, group, and slow-test budgets on reference hardware', () => {
    const report = evaluatePerformance(input({
      runEndMs: 92_000,
      files: [file('unit-example', 'unit.test.ts', 1_000, 22_000)],
      tests: [test('unit-example', 'unit.test.ts', 'slow unit', 251, 'passed')]
    }));

    expect(report.total).toMatchObject({ durationMs: 91_000, budgetMs: 90_000, exceeded: true });
    expect(report.groups[0]).toMatchObject({
      id: 'group-1',
      durationMs: 21_000,
      budgetMs: 20_000,
      slowTestBudgetMs: 250,
      exceeded: true
    });
    expect(report.violations).toEqual([
      { type: 'total', name: 'total', durationMs: 91_000, budgetMs: 90_000 },
      { type: 'group', name: 'group-1', durationMs: 21_000, budgetMs: 20_000 },
      { type: 'test', name: 'unit.test.ts > slow unit', durationMs: 251, budgetMs: 250 }
    ]);
  });

  it.each([
    [5, 8 * GIB],
    [6, 8 * GIB - 1]
  ])('reports without timing violations on smaller hardware (%i CPUs, %i bytes)', (availableCpus, totalMemoryBytes) => {
    const report = evaluatePerformance(input({
      workerPlan: resolveWorkerPlan({ availableCpus, totalMemoryBytes }),
      files: [file('dom-web', 'view.dom.test.tsx', 1_000, 20_000)],
      tests: [test('dom-web', 'view.dom.test.tsx', 'slow DOM case', 501, 'passed')]
    }));

    expect(report.groups[1]).toMatchObject({ durationMs: 19_000, exceeded: true });
    expect(report.tests[0]).toMatchObject({ durationMs: 501, exceeded: true });
    expect(report.violations).toEqual([]);
  });

  it('keeps assertion failure state independent from timing violations', () => {
    const report = evaluatePerformance(input({
      files: [file('integration', 'settings.integration.test.ts', 2_000, 3_000)],
      tests: [test('integration', 'settings.integration.test.ts', 'failed assertion', 20, 'failed')]
    }));

    expect(report.tests).toEqual([
      expect.objectContaining({ state: 'failed', exceeded: false })
    ]);
    expect(report.violations).toEqual([]);
  });

  it('keeps coverage timing measurements without enforcing instrumentation overhead', () => {
    const report = evaluatePerformance(input({
      enforceTimingBudgets: false,
      runEndMs: 92_000,
      files: [file('unit-example', 'unit.test.ts', 1_000, 22_000)],
      tests: [test('unit-example', 'unit.test.ts', 'instrumented unit', 251, 'passed')]
    }));

    expect(report.total).toMatchObject({ durationMs: 91_000, exceeded: true });
    expect(report.groups[0]).toMatchObject({ durationMs: 21_000, exceeded: true });
    expect(report.tests[0]).toMatchObject({ durationMs: 251, exceeded: true });
    expect(report.violations).toEqual([]);
    expect(resolvePerformanceExitCode(0, report.violations.length > 0)).toBe(0);
  });

  it.each([
    ['test:coverage', false],
    ['test', true],
    ['test:profile', true],
    ['test:stability', true],
    [undefined, true]
  ])('resolves timing enforcement for lifecycle %s', (lifecycleEvent, expected) => {
    expect(shouldEnforceTimingBudgets(lifecycleEvent)).toBe(expected);
  });

  it('maps stable project names to the four approved group and slow-test budgets', () => {
    const report = evaluatePerformance(input({
      files: [
        file('contracts', 'contract.test.ts', 1_000, 21_001),
        file('dom-web', 'view.dom.test.tsx', 1_000, 16_001),
        file('integration', 'service.integration.test.ts', 1_000, 41_001),
        file('system', 'runtime.system.test.ts', 1_000, 21_001),
        file('release', 'package.release.test.ts', 2_000, 20_000)
      ],
      tests: [
        test('unit-example', 'unit.test.ts', 'unit case', 251, 'passed'),
        test('dom-web', 'view.dom.test.tsx', 'DOM case', 501, 'passed'),
        test('integration', 'service.integration.test.ts', 'integration case', 2_001, 'passed'),
        test('release', 'package.release.test.ts', 'release case', 5_001, 'passed')
      ]
    }));

    expect(report.groups).toEqual([
      expect.objectContaining({ id: 'group-1', budgetMs: 20_000, slowTestBudgetMs: 250 }),
      expect.objectContaining({ id: 'group-2', budgetMs: 15_000, slowTestBudgetMs: 500 }),
      expect.objectContaining({ id: 'group-3', budgetMs: 40_000, slowTestBudgetMs: 2_000 }),
      expect.objectContaining({ id: 'group-4', budgetMs: 20_000, slowTestBudgetMs: 5_000 })
    ]);
    expect(report.tests.map(({ budgetMs }) => budgetMs).sort((left, right) => left - right))
      .toEqual([250, 500, 2_000, 5_000]);
    expect(report.violations.filter(({ type }) => type === 'group')).toHaveLength(4);
    expect(report.violations.filter(({ type }) => type === 'test')).toHaveLength(4);
  });

  it('sorts file and case diagnostics by duration and caps each list at ten', () => {
    const files = Array.from({ length: 12 }, (_, index) =>
      file('release', `release-${index}.release.test.ts`, index, index + 1, index + 1));
    const tests = Array.from({ length: 12 }, (_, index) =>
      test('release', `release-${index}.release.test.ts`, `case ${index}`, index + 1, 'passed'));

    const report = createSlowTestsReport(evaluatePerformance(input({ files, tests })));

    expect(report.files).toHaveLength(10);
    expect(report.tests).toHaveLength(10);
    expect(report.files.map(({ durationMs }) => durationMs)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    expect(report.tests.map(({ durationMs }) => durationMs)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  it('produces the complete deterministic JSON shape with all four groups', () => {
    const report = evaluatePerformance(input());

    expect(Object.keys(report)).toEqual(['workerPlan', 'total', 'groups', 'files', 'tests', 'violations']);
    expect(report.groups).toEqual([
      expect.objectContaining({ id: 'group-1', durationMs: 0, ran: false }),
      expect.objectContaining({ id: 'group-2', durationMs: 0, ran: false }),
      expect.objectContaining({ id: 'group-3', durationMs: 0, ran: false }),
      expect.objectContaining({ id: 'group-4', durationMs: 0, ran: false })
    ]);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

function file(
  projectName: string,
  path: string,
  startTimeMs: number,
  endTimeMs: number,
  durationMs = endTimeMs - startTimeMs
): PerformanceFileMeasurement {
  return { projectName, path, startTimeMs, endTimeMs, durationMs };
}

function test(
  projectName: string,
  path: string,
  name: string,
  durationMs: number,
  state: PerformanceTestMeasurement['state']
): PerformanceTestMeasurement {
  return { projectName, path, name, durationMs, state };
}
