import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  name: string;
  'runs-on': string;
  'timeout-minutes': number;
  steps: WorkflowStep[];
}

interface OrdinaryCiWorkflow {
  name: string;
  on: Record<string, { branches: string[]; 'paths-ignore': string[] }>;
  permissions: { contents: string };
  concurrency: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, WorkflowJob>;
}

const workflowSource = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8'
);
const workflow = parseYaml(workflowSource) as OrdinaryCiWorkflow;

function runCommands(job: WorkflowJob): string[] {
  return job.steps.flatMap((step) => step.run === undefined ? [] : [step.run]);
}

describe('ordinary GitHub CI workflow contract', () => {
  it('checks pull requests and main while skipping documentation-only changes', () => {
    expect(workflow.name).toBe('CI');
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push']);
    expect(workflow.on.pull_request).toEqual({
      branches: ['main'],
      'paths-ignore': ['**/*.md', 'docs/**']
    });
    expect(workflow.on.push).toEqual(workflow.on.pull_request);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency).toEqual({
      group: 'ci-${{ github.ref }}',
      'cancel-in-progress': true
    });
  });

  it('runs the confirmed macOS and Windows validation scopes on standard runners', () => {
    expect(Object.keys(workflow.jobs)).toEqual(['macos', 'windows-rust']);

    const macos = workflow.jobs.macos;
    const windows = workflow.jobs['windows-rust'];
    if (macos === undefined || windows === undefined) {
      throw new Error('ordinary CI jobs are missing');
    }
    expect(macos).toMatchObject({
      name: 'macOS validation',
      'runs-on': 'macos-latest',
      'timeout-minutes': 45
    });
    expect(windows).toMatchObject({
      name: 'Windows Rust validation',
      'runs-on': 'windows-latest',
      'timeout-minutes': 45
    });

    expect(runCommands(macos)).toEqual(expect.arrayContaining([
      'pnpm doctor',
      'pnpm check',
      'pnpm test',
      'pnpm lint:arch',
      'pnpm check:rust',
      'pnpm test:rust'
    ]));
    expect(runCommands(windows)).toEqual(expect.arrayContaining([
      'pnpm doctor',
      'pnpm check:rust',
      'pnpm test:rust'
    ]));
  });

  it('caches downloads without adding a local full-gate or compiled-output cache', () => {
    const cacheSteps = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses === 'actions/cache@v4');

    expect(cacheSteps).toHaveLength(2);
    for (const step of cacheSteps) {
      expect(step.with?.path).toBe('~/.cargo/registry\n~/.cargo/git\n');
      expect(step.with?.key).toBe(
        "${{ runner.os }}-cargo-downloads-${{ hashFiles('Cargo.lock') }}"
      );
    }
    expect(workflowSource).not.toContain('sccache');
    expect(workflowSource).not.toContain('pnpm verify');
    expect(workflowSource).not.toContain('pnpm build');
    expect(workflowSource).not.toContain('check:rust:all');
    expect(workflowSource).not.toContain('test:rust:native-watcher');
    expect(workflowSource).not.toContain('verify:browser');
  });
});
