import type { WorkbenchApiClient } from '@debrute/app-protocol';
import type { AcceptedProjectPathCommandScope } from './projectPathCommandIntake.js';

export type ProjectPathEffectApi = Pick<WorkbenchApiClient,
  | 'sendProjectFileToPhotoshop'
  | 'loadProjectDirectory'
  | 'createProjectFile'
  | 'createProjectDirectory'
  | 'renameProjectPath'
  | 'copyProjectPaths'
  | 'moveProjectPaths'
  | 'copyProjectPathsToSystemClipboard'
  | 'trashProjectPaths'
  | 'deleteProjectPathsPermanently'
  | 'importExternalLocalProjectPaths'
  | 'importExternalProjectUploads'
  | 'revealProjectPathInSystemFileManager'
>;

export type ProjectPathEffectApiName = keyof ProjectPathEffectApi;

type ScopedProjectPathEffect<Method> = Method extends (...args: infer Args) => infer Result
  ? (scope: AcceptedProjectPathCommandScope, ...args: Args) => Result | undefined
  : never;

export type ProjectPathCommandEffects = {
  [Name in keyof ProjectPathEffectApi]: ScopedProjectPathEffect<ProjectPathEffectApi[Name]>;
};

export function createProjectPathCommandEffects(
  api: ProjectPathEffectApi
): ProjectPathCommandEffects {
  const submit = <Result>(
    scope: AcceptedProjectPathCommandScope,
    effect: () => Result
  ): Result | undefined => scope.canSubmit() ? effect() : undefined;

  return {
    sendProjectFileToPhotoshop: (scope, input) => submit(
      scope,
      () => api.sendProjectFileToPhotoshop(input)
    ),
    loadProjectDirectory: (scope, directory) => submit(
      scope,
      () => api.loadProjectDirectory(directory)
    ),
    createProjectFile: (scope, input) => submit(scope, () => api.createProjectFile(input)),
    createProjectDirectory: (scope, input) => submit(scope, () => api.createProjectDirectory(input)),
    renameProjectPath: (scope, input) => submit(scope, () => api.renameProjectPath(input)),
    copyProjectPaths: (scope, input) => submit(scope, () => api.copyProjectPaths(input)),
    moveProjectPaths: (scope, input) => submit(scope, () => api.moveProjectPaths(input)),
    copyProjectPathsToSystemClipboard: (scope, input) => submit(
      scope,
      () => api.copyProjectPathsToSystemClipboard(input)
    ),
    trashProjectPaths: (scope, input) => submit(scope, () => api.trashProjectPaths(input)),
    deleteProjectPathsPermanently: (scope, input) => submit(
      scope,
      () => api.deleteProjectPathsPermanently(input)
    ),
    importExternalLocalProjectPaths: (scope, input) => submit(
      scope,
      () => api.importExternalLocalProjectPaths(input)
    ),
    importExternalProjectUploads: (scope, input) => submit(
      scope,
      () => api.importExternalProjectUploads(input)
    ),
    revealProjectPathInSystemFileManager: (scope, input) => submit(
      scope,
      () => api.revealProjectPathInSystemFileManager(input)
    )
  };
}
