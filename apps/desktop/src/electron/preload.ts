import electron from 'electron';

const { contextBridge, ipcRenderer } = electron;

interface AxisShellApi {
  chooseProjectRoot(): Promise<string | undefined>;
  bindProjectWindowToProject(input: { projectId: string }): Promise<{ ok: true }>;
  revealProjectPathInSystemFileManager(input: { projectId: string; projectRelativePath: string; kind: 'file' | 'directory' }): Promise<{ ok: true }>;
}

const axisShellApi: AxisShellApi = {
  chooseProjectRoot: () => ipcRenderer.invoke('axis-shell:chooseProjectRoot') as Promise<string | undefined>,
  bindProjectWindowToProject: (input) => (
    ipcRenderer.invoke('axis-shell:bindProjectWindowToProject', input) as Promise<{ ok: true }>
  ),
  revealProjectPathInSystemFileManager: (input) => (
    ipcRenderer.invoke('axis-shell:revealProjectPathInSystemFileManager', input) as Promise<{ ok: true }>
  )
};

contextBridge.exposeInMainWorld('axisShell', axisShellApi);
