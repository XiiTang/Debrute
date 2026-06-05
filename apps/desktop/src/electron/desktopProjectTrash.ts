export type DesktopProjectTrashKind = 'file' | 'directory';

export interface DesktopProjectTrashInput {
  projectId: string;
  projectRelativePath: string;
  kind: DesktopProjectTrashKind;
}

export interface DesktopProjectTrashRuntimeClient {
  resolveProjectPath(projectId: string, projectRelativePath: string, kind: DesktopProjectTrashKind): Promise<string>;
}

export interface DesktopProjectTrashShell {
  trashItem(absolutePath: string): Promise<void>;
}

export async function trashProjectPathWithDesktopShell(
  input: {
    runtimeClient: DesktopProjectTrashRuntimeClient;
    shell: DesktopProjectTrashShell;
  },
  trashInput: DesktopProjectTrashInput
): Promise<{ ok: true }> {
  const absolutePath = await input.runtimeClient.resolveProjectPath(
    trashInput.projectId,
    trashInput.projectRelativePath,
    trashInput.kind
  );
  await input.shell.trashItem(absolutePath);
  return { ok: true };
}
