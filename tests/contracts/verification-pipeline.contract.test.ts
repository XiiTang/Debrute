import { describe, expect, it, vi } from 'vitest';
import {
  runVerification,
  verificationStages
} from '../../scripts/verification-pipeline.mjs';

describe('timed verification pipeline', () => {
  it('runs generation and type checking once before artifact-only build', async () => {
    const scripts: string[] = [];
    const output: string[] = [];

    await runVerification({
      runScript: async (script) => {
        scripts.push(script);
      },
      now: advancingClock(),
      write: (value) => output.push(value)
    });

    expect(scripts).toEqual([
      'doctor',
      'generate:control-protocol',
      'check:typescript',
      'check:rust',
      'test',
      'test:rust',
      'lint:arch',
      'build:artifacts'
    ]);
    expect(output.join('')).toMatch(/Verification summary/);
    expect(output.join('')).toMatch(/generate:control-protocol\s+0\.25s/);
    expect(output.join('')).toMatch(/total\s+2\.00s/);
  });

  it('selects exhaustive Clippy instead of running both Rust lint scopes', () => {
    expect(verificationStages({ allRustTargets: true }).map(({ script }) => script)).toEqual([
      'doctor',
      'generate:control-protocol',
      'check:typescript',
      'check:rust:all',
      'test',
      'test:rust',
      'lint:arch',
      'build:artifacts'
    ]);
  });

  it('stops at the failed stage and reports completed and failed timings', async () => {
    const scripts: string[] = [];
    const output: string[] = [];
    const failure = new Error('fixture Rust lint failed');

    await expect(runVerification({
      runScript: async (script) => {
        scripts.push(script);
        if (script === 'check:rust') throw failure;
      },
      now: advancingClock(),
      write: (value) => output.push(value)
    })).rejects.toBe(failure);

    expect(scripts).toEqual([
      'doctor',
      'generate:control-protocol',
      'check:typescript',
      'check:rust'
    ]);
    expect(output.join('')).toMatch(/check:rust\s+failed\s+0\.25s/);
    expect(output.join('')).not.toMatch(/build:artifacts\s+(passed|failed)/);
  });

  it('rejects an unknown command-line argument', async () => {
    const { parseVerificationArguments } = await import('../../scripts/verification-pipeline.mjs');
    expect(() => parseVerificationArguments(['--unsupported-option'])).toThrow(
      'Unknown verify argument: --unsupported-option'
    );
  });
});

function advancingClock(): () => number {
  let value = 0;
  return vi.fn(() => {
    const current = value;
    value += 250;
    return current;
  });
}
