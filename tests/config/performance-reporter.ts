import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Reporter, TestCase, TestModule } from 'vitest/node';

import { testWorkerPlan, type TestWorkerPlan } from './workers.js';

const TOTAL_BUDGET_MS = 90_000;
const REPORT_DIRECTORY = '.test-results';

type PerformanceGroupId = 'group-1' | 'group-2' | 'group-3' | 'group-4';

interface PerformanceGroupDefinition {
  id: PerformanceGroupId;
  budgetMs: number;
  slowTestBudgetMs: number;
}

const GROUP_1: PerformanceGroupDefinition = {
  id: 'group-1', budgetMs: 20_000, slowTestBudgetMs: 250
};
const GROUP_2: PerformanceGroupDefinition = {
  id: 'group-2', budgetMs: 15_000, slowTestBudgetMs: 500
};
const GROUP_3: PerformanceGroupDefinition = {
  id: 'group-3', budgetMs: 40_000, slowTestBudgetMs: 2_000
};
const GROUP_4: PerformanceGroupDefinition = {
  id: 'group-4', budgetMs: 20_000, slowTestBudgetMs: 5_000
};
const GROUP_DEFINITIONS = [GROUP_1, GROUP_2, GROUP_3, GROUP_4] as const;

export interface PerformanceFileMeasurement {
  projectName: string;
  path: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
}

export interface PerformanceTestMeasurement {
  projectName: string;
  path: string;
  name: string;
  durationMs: number;
  state: 'passed' | 'failed' | 'skipped';
}

export interface PerformanceEvaluationInput {
  workerPlan: TestWorkerPlan;
  enforceTimingBudgets: boolean;
  runStartMs: number;
  runEndMs: number;
  files: readonly PerformanceFileMeasurement[];
  tests: readonly PerformanceTestMeasurement[];
}

interface PerformanceFileReport extends PerformanceFileMeasurement {
  group: PerformanceGroupId;
}

interface PerformanceTestReport extends PerformanceTestMeasurement {
  group: PerformanceGroupId;
  budgetMs: number;
  exceeded: boolean;
}

interface PerformanceGroupReport extends PerformanceGroupDefinition {
  projects: string[];
  ran: boolean;
  durationMs: number;
  fileCount: number;
  testCount: number;
  exceeded: boolean;
}

interface PerformanceViolation {
  type: 'total' | 'group' | 'test';
  name: string;
  durationMs: number;
  budgetMs: number;
}

export interface PerformanceReport {
  workerPlan: TestWorkerPlan;
  total: {
    durationMs: number;
    budgetMs: number;
    exceeded: boolean;
  };
  groups: PerformanceGroupReport[];
  files: PerformanceFileReport[];
  tests: PerformanceTestReport[];
  violations: PerformanceViolation[];
}

export interface SlowTestsReport {
  files: PerformanceFileReport[];
  tests: PerformanceTestReport[];
}

export function evaluatePerformance(input: PerformanceEvaluationInput): PerformanceReport {
  const files = input.files.map((measurement) => ({
    ...measurement,
    group: groupForProject(measurement.projectName).id
  })).sort(compareMeasurements);
  const tests = input.tests.map((measurement) => {
    const group = groupForProject(measurement.projectName);
    return {
      ...measurement,
      group: group.id,
      budgetMs: group.slowTestBudgetMs,
      exceeded: measurement.durationMs > group.slowTestBudgetMs
    };
  }).sort(compareMeasurements);
  const total = {
    durationMs: input.runEndMs - input.runStartMs,
    budgetMs: TOTAL_BUDGET_MS,
    exceeded: input.runEndMs - input.runStartMs > TOTAL_BUDGET_MS
  };
  const groups = GROUP_DEFINITIONS.map((definition): PerformanceGroupReport => {
    const groupFiles = files.filter(({ group }) => group === definition.id);
    const groupTests = tests.filter(({ group }) => group === definition.id);
    const firstStartMs = Math.min(...groupFiles.map(({ startTimeMs }) => startTimeMs));
    const lastEndMs = Math.max(...groupFiles.map(({ endTimeMs }) => endTimeMs));
    const durationMs = groupFiles.length === 0 ? 0 : lastEndMs - firstStartMs;
    return {
      ...definition,
      projects: [...new Set(groupFiles.map(({ projectName }) => projectName))].sort(),
      ran: groupFiles.length > 0,
      durationMs,
      fileCount: groupFiles.length,
      testCount: groupTests.length,
      exceeded: durationMs > definition.budgetMs
    };
  });
  const violations: PerformanceViolation[] = [];

  if (input.workerPlan.referenceHardware && input.enforceTimingBudgets) {
    if (total.exceeded) {
      violations.push({
        type: 'total',
        name: 'total',
        durationMs: total.durationMs,
        budgetMs: total.budgetMs
      });
    }
    for (const group of groups) {
      if (group.exceeded) {
        violations.push({
          type: 'group',
          name: group.id,
          durationMs: group.durationMs,
          budgetMs: group.budgetMs
        });
      }
    }
    for (const test of tests) {
      if (test.exceeded) {
        violations.push({
          type: 'test',
          name: `${test.path} > ${test.name}`,
          durationMs: test.durationMs,
          budgetMs: test.budgetMs
        });
      }
    }
  }

  return {
    workerPlan: input.workerPlan,
    total,
    groups,
    files,
    tests,
    violations
  };
}

export function createSlowTestsReport(report: PerformanceReport): SlowTestsReport {
  return {
    files: report.files.slice(0, 10),
    tests: report.tests.slice(0, 10)
  };
}

export function resolvePerformanceExitCode(
  current: typeof process.exitCode,
  hasTimingViolations: boolean
): typeof process.exitCode {
  if (
    !hasTimingViolations
    || (current !== undefined && current !== 0 && current !== '0')
  ) {
    return current;
  }
  return 1;
}

export function shouldEnforceTimingBudgets(lifecycleEvent: string | undefined): boolean {
  return lifecycleEvent !== 'test:coverage';
}

export default class PerformanceReporter implements Reporter {
  private runStartMs = 0;
  private enforceTimingBudgets = true;
  private readonly moduleStarts = new Map<string, {
    projectName: string;
    path: string;
    startTimeMs: number;
  }>();
  private readonly files: PerformanceFileMeasurement[] = [];
  private readonly tests: PerformanceTestMeasurement[] = [];

  onTestRunStart(): void {
    this.runStartMs = Date.now();
    this.enforceTimingBudgets = shouldEnforceTimingBudgets(process.env.npm_lifecycle_event);
    this.moduleStarts.clear();
    this.files.length = 0;
    this.tests.length = 0;
    process.stdout.write(
      `Debrute test plan: cpu=${testWorkerPlan.availableCpus} reserved=2 unit=${testWorkerPlan.unitWorkers} `
      + `dom=${testWorkerPlan.domWorkers} integration=${testWorkerPlan.integrationWorkers} `
      + `system=${testWorkerPlan.systemWorkers}\n`
    );
    if (!this.enforceTimingBudgets) {
      process.stdout.write('Debrute timing enforcement: disabled for coverage instrumentation\n');
    }
  }

  onTestModuleStart(testModule: TestModule): void {
    this.moduleStarts.set(testModule.id, {
      projectName: testModule.project.name,
      path: normalizePath(testModule.relativeModuleId),
      startTimeMs: Date.now()
    });
  }

  onTestCaseResult(testCase: TestCase): void {
    const diagnostic = testCase.diagnostic();
    if (!diagnostic) {
      return;
    }
    const result = testCase.result();
    if (result.state === 'pending') {
      throw new Error(`Test case "${testCase.fullName}" reported a pending result after completion`);
    }
    this.tests.push({
      projectName: testCase.project.name,
      path: normalizePath(testCase.module.relativeModuleId),
      name: testCase.fullName,
      durationMs: diagnostic.duration,
      state: result.state
    });
  }

  onTestModuleEnd(testModule: TestModule): void {
    const measurement = this.moduleStarts.get(testModule.id);
    if (!measurement) {
      throw new Error(`Test module "${testModule.relativeModuleId}" ended without starting`);
    }
    this.files.push({
      ...measurement,
      endTimeMs: Date.now(),
      durationMs: testModule.diagnostic().duration
    });
  }

  async onTestRunEnd(): Promise<void> {
    const report = evaluatePerformance({
      workerPlan: testWorkerPlan,
      enforceTimingBudgets: this.enforceTimingBudgets,
      runStartMs: this.runStartMs,
      runEndMs: Date.now(),
      files: this.files,
      tests: this.tests
    });

    printReport(report);

    if (process.env.npm_lifecycle_event === 'test:profile') {
      const directory = resolve(process.cwd(), REPORT_DIRECTORY);
      await mkdir(directory, { recursive: true });
      await writeAtomicJson(resolve(directory, 'timing.json'), report);
      await writeAtomicJson(resolve(directory, 'slow-tests.json'), createSlowTestsReport(report));
    }

    const exitCode = resolvePerformanceExitCode(process.exitCode, report.violations.length > 0);
    if (exitCode !== process.exitCode) {
      process.exitCode = exitCode;
    }
  }
}

function groupForProject(projectName: string): PerformanceGroupDefinition {
  if (projectName === 'contracts' || projectName.startsWith('unit-')) {
    return GROUP_1;
  }
  if (projectName === 'dom-web') {
    return GROUP_2;
  }
  if (projectName === 'integration') {
    return GROUP_3;
  }
  if (projectName === 'system' || projectName === 'release') {
    return GROUP_4;
  }
  throw new Error(`Unknown Vitest project "${projectName}"`);
}

function compareMeasurements(
  left: { durationMs: number; path: string; name?: string },
  right: { durationMs: number; path: string; name?: string }
): number {
  return right.durationMs - left.durationMs
    || compareText(left.path, right.path)
    || compareText(left.name ?? '', right.name ?? '');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function printReport(report: PerformanceReport): void {
  const slowTests = createSlowTestsReport(report);
  for (const group of report.groups.filter(({ ran }) => ran)) {
    process.stdout.write(
      `Debrute ${group.id}: ${formatDuration(group.durationMs)} / ${formatDuration(group.budgetMs)}\n`
    );
  }
  process.stdout.write(
    `Debrute total: ${formatDuration(report.total.durationMs)} / ${formatDuration(report.total.budgetMs)}\n`
  );
  printMeasurements('slowest files', slowTests.files);
  printMeasurements('slowest cases', slowTests.tests);
  if (report.violations.length === 0) {
    process.stdout.write('Debrute timing violations: none\n');
    return;
  }
  process.stdout.write('Debrute timing violations:\n');
  for (const violation of report.violations) {
    process.stdout.write(
      `  ${violation.type} ${violation.name}: ${formatDuration(violation.durationMs)} `
      + `> ${formatDuration(violation.budgetMs)}\n`
    );
  }
}

function printMeasurements(
  label: string,
  measurements: readonly { durationMs: number; path: string; name?: string }[]
): void {
  process.stdout.write(`Debrute ${label}:\n`);
  for (const measurement of measurements) {
    process.stdout.write(
      `  ${formatDuration(measurement.durationMs)} ${measurement.path}`
      + `${measurement.name ? ` > ${measurement.name}` : ''}\n`
    );
  }
}

function formatDuration(durationMs: number): string {
  return `${durationMs.toFixed(0)}ms`;
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}
