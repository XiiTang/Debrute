import { describe, expect, it } from 'vitest';

import {
  createSlowTestsReport,
  evaluatePerformance,
  type PerformanceEvaluationInput,
  type PerformanceFileMeasurement,
  type PerformanceTestMeasurement
} from '../config/performance-reporter.js';
import { resolveWorkerPlan } from '../config/workers.js';

function input(overrides: Partial<PerformanceEvaluationInput> = {}): PerformanceEvaluationInput {
  return {
    workerPlan: resolveWorkerPlan({ availableCpus: 6 }),
    runStartMs: 1_000,
    runEndMs: 11_000,
    files: [],
    tests: [],
    ...overrides
  };
}

describe('performance reporter contract', () => {
  it('marks total, group, and slow-test diagnostic thresholds', () => {
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
    expect(report.tests[0]).toMatchObject({ durationMs: 251, exceeded: true });
  });

  it('keeps assertion failure state independent from timing observations', () => {
    const report = evaluatePerformance(input({
      files: [file('release', 'settings.release.test.ts', 2_000, 3_000)],
      tests: [test('release', 'settings.release.test.ts', 'failed assertion', 20, 'failed')]
    }));

    expect(report.tests).toEqual([
      expect.objectContaining({ state: 'failed', exceeded: false })
    ]);
  });

  it('maps stable project names to the three approved group and slow-test budgets', () => {
    const report = evaluatePerformance(input({
      files: [
        file('contracts', 'contract.test.ts', 1_000, 21_001),
        file('dom-web', 'view.dom.test.tsx', 1_000, 21_001),
        file('release', 'runtime.release.test.ts', 1_000, 21_001),
        file('release', 'package.release.test.ts', 2_000, 20_000)
      ],
      tests: [
        test('unit-example', 'unit.test.ts', 'unit case', 251, 'passed'),
        test('dom-web', 'view.dom.test.tsx', 'DOM case', 501, 'passed'),
        test('release', 'package.release.test.ts', 'release case', 5_001, 'passed')
      ]
    }));

    expect(report.groups).toEqual([
      expect.objectContaining({ id: 'group-1', budgetMs: 20_000, slowTestBudgetMs: 250 }),
      expect.objectContaining({ id: 'group-2', budgetMs: 20_000, slowTestBudgetMs: 500 }),
      expect.objectContaining({ id: 'group-3', budgetMs: 20_000, slowTestBudgetMs: 5_000 })
    ]);
    expect(report.tests.map(({ budgetMs }) => budgetMs).sort((left, right) => left - right))
      .toEqual([250, 500, 5_000]);
    expect(report.groups.map(({ exceeded }) => exceeded)).toEqual([true, true, true]);
    expect(report.tests.map(({ exceeded }) => exceeded)).toEqual([true, true, true]);
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

  it('produces the complete deterministic JSON shape with all three groups', () => {
    const report = evaluatePerformance(input());

    expect(Object.keys(report)).toEqual(['workerPlan', 'total', 'groups', 'files', 'tests']);
    expect(report.groups).toEqual([
      expect.objectContaining({ id: 'group-1', durationMs: 0, ran: false }),
      expect.objectContaining({ id: 'group-2', durationMs: 0, ran: false }),
      expect.objectContaining({ id: 'group-3', durationMs: 0, ran: false })
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
