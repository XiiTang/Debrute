import type {
  CopyProjectPathsInput,
  CreateProjectPathInput,
  DeleteProjectPathsInput,
  ImportExternalLocalProjectPathsInput,
  ImportExternalUploadProjectEntriesInput,
  MoveProjectPathsInput,
  RenameProjectPathInput
} from '@debrute/project-core';
import {
  copyProjectPaths,
  createProjectDirectory,
  createProjectFile,
  deleteProjectPathsPermanently,
  importExternalLocalProjectPaths,
  importExternalUploadProjectEntries,
  moveProjectPaths,
  renameProjectPath
} from '@debrute/project-core';
import type { ProjectFileBatchOperationResult, ProjectFileOperationResult, ProjectSessionSnapshot } from '@debrute/app-protocol';

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

export async function copyProjectPathsWithSnapshot(
  context: ProjectFileOperationContext,
  input: CopyProjectPathsInput
): Promise<ProjectFileBatchOperationResult> {
  const result = await copyProjectPaths(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function moveProjectPathsWithSnapshot(
  context: ProjectFileOperationContext,
  input: MoveProjectPathsInput
): Promise<ProjectFileBatchOperationResult> {
  const result = await moveProjectPaths(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function deleteProjectPathsPermanentlyWithSnapshot(
  context: ProjectFileOperationContext,
  input: DeleteProjectPathsInput
): Promise<ProjectFileBatchOperationResult> {
  const result = await deleteProjectPathsPermanently(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function importExternalLocalProjectPathsWithSnapshot(
  context: ProjectFileOperationContext,
  input: ImportExternalLocalProjectPathsInput
): Promise<ProjectFileBatchOperationResult> {
  const result = await importExternalLocalProjectPaths(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}

export async function importExternalUploadProjectEntriesWithSnapshot(
  context: ProjectFileOperationContext,
  input: ImportExternalUploadProjectEntriesInput
): Promise<ProjectFileBatchOperationResult> {
  const result = await importExternalUploadProjectEntries(context.snapshot.projectRoot, input);
  return { ...result, snapshot: await context.refreshProject() };
}
