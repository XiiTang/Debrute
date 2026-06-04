export interface AxisShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  bindProjectWindowToProject?(input: { projectId: string }): Promise<{ ok: true }>;
  revealProjectPathInSystemFileManager?(input: { projectId: string; projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
}

export function getAxisShellApi(): AxisShellApi | undefined {
  return typeof window === 'undefined' ? undefined : window.axisShell;
}
