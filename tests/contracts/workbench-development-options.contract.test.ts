import { describe, expect, it } from 'vitest';
import { parseWorkbenchDevelopmentOptions } from '../../scripts/workbench-development-options.js';

describe('Workbench development options', () => {
  it('keeps the Canvas performance probe off by default', () => {
    expect(parseWorkbenchDevelopmentOptions([])).toEqual({ canvasPerfEnabled: false });
  });

  it('enables the Canvas performance probe for the explicit startup flag', () => {
    expect(parseWorkbenchDevelopmentOptions(['--', '--canvas-perf'])).toEqual({ canvasPerfEnabled: true });
  });

  it('rejects unsupported startup arguments', () => {
    expect(() => parseWorkbenchDevelopmentOptions(['--unknown'])).toThrow(
      'Unknown Workbench development argument: --unknown'
    );
  });
});
