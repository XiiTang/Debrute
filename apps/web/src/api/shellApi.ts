import type { DebruteShellApi } from '@debrute/app-protocol';

export type { DebruteShellApi, NativeWindowState } from '@debrute/app-protocol';

export function getDebruteShellApi(): DebruteShellApi | undefined {
  return window.debruteShell;
}
