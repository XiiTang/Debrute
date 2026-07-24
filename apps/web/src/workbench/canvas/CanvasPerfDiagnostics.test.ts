import { describe, expect, it } from 'vitest';
import { canvasPerfDiagnosticsEnabled } from './CanvasPerfDiagnostics';

describe('CanvasPerfDiagnostics', () => {
  it('enables Canvas instrumentation only for an enabled development process', () => {
    expect(canvasPerfDiagnosticsEnabled({ development: true, startupEnabled: false })).toBe(false);
    expect(canvasPerfDiagnosticsEnabled({ development: true, startupEnabled: true })).toBe(true);
    expect(canvasPerfDiagnosticsEnabled({ development: false, startupEnabled: true })).toBe(false);
  });
});
