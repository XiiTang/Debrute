import type {
  CopyOrMoveProjectPathInput,
  CreateProjectPathInput,
  DeleteProjectPathInput,
  RenameProjectPathInput
} from '@debrute/project-core';
import {
  copyProjectPath,
  createProjectDirectory,
  createProjectFile,
  deleteProjectPathPermanently,
  moveProjectPath,
  renameProjectPath
} from '@debrute/project-core';
import type { ProjectFileOperationResult, ProjectSessionSnapshot } from '@debrute/app-protocol';

export interface ProjectFileOperationContext {
  snapshot: ProjectSessionSnapshot;
  refreshProject(): Promise<ProjectSessionSnapshot>;
}

export async function createProjectFileWithSnapshot(
  context: ProjectFileOperationContext,
  input: CreateProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await createProjectFile(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function createProjectDirectoryWithSnapshot(
  context: ProjectFileOperationContext,
  input: CreateProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await createProjectDirectory(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function renameProjectPathWithSnapshot(
  context: ProjectFileOperationContext,
  input: RenameProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await renameProjectPath(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function copyProjectPathWithSnapshot(
  context: ProjectFileOperationContext,
  input: CopyOrMoveProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await copyProjectPath(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function moveProjectPathWithSnapshot(
  context: ProjectFileOperationContext,
  input: CopyOrMoveProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await moveProjectPath(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function deleteProjectPathPermanentlyWithSnapshot(
  context: ProjectFileOperationContext,
  input: DeleteProjectPathInput
): Promise<ProjectFileOperationResult> {
  const result = await deleteProjectPathPermanently(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}
